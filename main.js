// ============================================================
//  main.js — Processo principal Electron
//  Responsável por: janelas, contas WhatsApp, banco de dados
//  e toda a lógica de validação de telefones.
// ============================================================

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path   = require('path');
const fs     = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const archiver = require('archiver');
const { Pool } = require('pg');
const QRCode = require('qrcode');

// ── Constantes ────────────────────────────────────────────────
const EDGE_PATH_X86 = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EDGE_PATH_X64 = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const OUTPUT_DIR    = path.join(__dirname, 'output');

// ── Conexão com o banco (PostgreSQL / Supabase) ───────────────
// Pool inicializado via IPC 'connect-db' — não há credenciais em disco.
let pool = null;

// ── Estado global da aplicação ────────────────────────────────
let mainWindow    = null;
let bancoWindow   = null;
let connectWindow = null;

// Sinaliza ao loop de validação que deve parar na próxima iteração
let cancelRequested = false;

// Guarda o ponto de retomada para a funcionalidade "Pausar"
let resumeState = null;

// Cache em memória para evitar consultas repetidas ao banco durante uma sessão
let phoneCache = null;

// ── Estado das contas WhatsApp (multi-conta) ──────────────────
// Estrutura: Map<id, { client, isReady, qrDataUrl, info, profilePicUrl, status }>
const accounts = new Map();
let rrIndex       = 0; // índice do round-robin para distribuição das consultas
let nextAccountId = 1;

// ── Semaphore para limitar concorrência ──────────────────────
class Semaphore {
  constructor(max) { this.max = max; this.current = 0; this.queue = []; }
  async acquire() {
    if (this.current < this.max) { this.current++; return; }
    await new Promise(resolve => this.queue.push(resolve));
    this.current++;
  }
  release() {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }
}
const validationSemaphore = new Semaphore(10); // máx 10 promises simultâneas

// ── Path traversal validation ────────────────────────────────
function isSafeFilePath(userPath) {
  try {
    const resolved = path.resolve(userPath);
    const cwd = path.resolve(process.cwd());
    // Verifica se o caminho resolvido começa com CWD e não tem ..
    return resolved.startsWith(cwd) && !resolved.includes('..' + path.sep);
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  UTILITÁRIOS DE DATA/HORA
// ═══════════════════════════════════════════════════════════════

/**
 * Formata um objeto Date como string "YYYY-MM-DD HH:MM:SS" em UTC.
 * O banco armazena no horário de Brasília (BRT = UTC-3), por isso
 * não fazemos conversão aqui — usamos os valores UTC diretamente.
 */
function formatDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const p  = n => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} `
       + `${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
}

/**
 * Retorna a hora atual ajustada para UTC-3 (horário de Brasília).
 * Usado ao gravar timestamps no banco para manter consistência com BRT.
 */
function nowBRT() {
  return formatDate(new Date(Date.now() - 3 * 60 * 60 * 1000));
}

/**
 * Gera um timestamp compacto para uso em nomes de arquivo (ex: 20260404_153022).
 */
function makeTimestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
       + `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ═══════════════════════════════════════════════════════════════
//  UTILITÁRIOS DE TELEFONE
// ═══════════════════════════════════════════════════════════════

/**
 * Normaliza um número de telefone para o formato E.164 brasileiro (55 + DDD + número).
 * - Remove caracteres não numéricos.
 * - Retorna vazio se o resultado tiver menos de 8 dígitos.
 * - Adiciona o código de país 55 se necessário.
 */
function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 8) return '';
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits;
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits;
}

/**
 * Extrai e normaliza o número de telefone de uma linha de texto delimitada por ";".
 * @param {string} line     Linha do arquivo de entrada.
 * @param {number} phoneCol Índice (0-based) da coluna que contém o telefone.
 */
function extractPhoneFromLine(line, phoneCol = 0) {
  if (!line || !line.trim()) return '';
  const col = line.split(';')[phoneCol]?.trim() || '';
  return normalizePhone(col);
}

// ═══════════════════════════════════════════════════════════════
//  UTILITÁRIOS GERAIS
// ═══════════════════════════════════════════════════════════════

/** Aguarda `ms` milissegundos. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Retorna um número inteiro aleatório no intervalo [min, max]. */
function randBetween(min, max) {
  const a = Number(min) || 0;
  const b = Number(max) || 0;
  if (b <= a) return a;
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

/** Reinicia o cache em memória (chamado ao iniciar uma nova validação). */
function initSessionCache() {
  phoneCache = {};
}

// ═══════════════════════════════════════════════════════════════
//  COMUNICAÇÃO COM O FRONTEND (broadcast)
// ═══════════════════════════════════════════════════════════════

/**
 * Notifica todas as janelas abertas sobre mudança no estado da conexão com o banco.
 * @param {{ connected: boolean }} data
 */
function broadcastDbStatus(data) {
  mainWindow?.webContents.send('db-status', data);
  if (bancoWindow && !bancoWindow.isDestroyed()) {
    bancoWindow.webContents.send('db-status', data);
  }
}

/**
 * Envia um evento de status do WhatsApp para todas as janelas abertas.
 * @param {{ type: string, message: string }} data
 */
function broadcastWaStatus(data) {
  mainWindow?.webContents.send('wa-status', data);
  if (connectWindow && !connectWindow.isDestroyed()) {
    connectWindow.webContents.send('wa-status', data);
  }
}

/**
 * Notifica o frontend sobre mudanças no estado das contas
 * (ex: QR Code gerado, conta conectada, desconectada).
 */
function broadcastAccountUpdate() {
  const payload = { type: 'account-update', accounts: getAccountList() };
  mainWindow?.webContents.send('wa-accounts', payload);
}

// ═══════════════════════════════════════════════════════════════
//  GERENCIAMENTO DE CONTAS WHATSAPP
// ═══════════════════════════════════════════════════════════════

/**
 * Retorna a lista serializada de todas as contas para envio ao frontend.
 */
function getAccountList() {
  return [...accounts.entries()].map(([id, acc]) => ({
    id,
    isReady:       acc.isReady,
    qrDataUrl:     acc.qrDataUrl || null,
    name:          acc.info?.pushname || '',
    phone:         acc.info?.wid?.user || '',
    platform:      acc.info?.platform || '',
    profilePicUrl: acc.profilePicUrl || null,
    status:        acc.status || 'disconnected'
  }));
}

/** Retorna somente as contas prontas para uso. */
function getConnectedClients() {
  return [...accounts.values()].filter(a => a.isReady && a.client);
}

/**
 * Seleciona o próximo cliente usando round-robin,
 * distribuindo as consultas uniformemente entre as contas conectadas.
 */
function getNextClient() {
  const connected = getConnectedClients();
  if (!connected.length) return null;
  rrIndex = rrIndex % connected.length;
  const acc = connected[rrIndex];
  rrIndex = (rrIndex + 1) % connected.length;
  return acc.client;
}

/** Persiste a lista de IDs de contas no disco para restauração na próxima abertura. */
function saveAccountIds() {
  try {
    const p = path.join(app.getPath('userData'), 'wa-accounts.json');
    fs.writeFileSync(p, JSON.stringify([...accounts.keys()]), 'utf8');
  } catch {}
}

/** Carrega os IDs de contas salvas em disco. Retorna [] se não existir. */
function loadSavedAccountIds() {
  try {
    const p = path.join(app.getPath('userData'), 'wa-accounts.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn('[loadSavedAccountIds] Erro ao carregar IDs de contas:', err.message);
  }
  return [];
}

/**
 * Inicializa uma conta WhatsApp via whatsapp-web.js.
 * Cada conta tem sua própria sessão persistida em disco via LocalAuth.
 * Os eventos (qr, authenticated, ready, disconnected) atualizam o estado
 * e notificam o frontend via broadcast.
 *
 * @param {string} id  Identificador da conta (ex: "account-1").
 */
async function startAccount(id) {
  if (accounts.has(id)) return;

  const acc = {
    client:        null,
    isReady:       false,
    qrDataUrl:     null,
    info:          null,
    profilePicUrl: null,
    status:        'connecting'
  };
  accounts.set(id, acc);
  saveAccountIds();

  const sessionPath = path.join(app.getPath('userData'), 'wwebjs-session-' + id);
  const edgePath    = fs.existsSync(EDGE_PATH_X86) ? EDGE_PATH_X86 : EDGE_PATH_X64;

  acc.client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath, clientId: id }),
    puppeteer: {
      headless:        true,
      executablePath:  edgePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  // QR Code gerado — precisa ser escaneado pelo usuário no celular
  acc.client.on('qr', async qrString => {
    try {
      acc.qrDataUrl = await QRCode.toDataURL(qrString, { margin: 1, width: 280 });
    } catch {
      acc.qrDataUrl = null;
    }
    acc.status = 'qr';
    broadcastAccountUpdate();
    broadcastWaStatus({ type: 'qr', message: `Conta ${id}: leia o QR Code.` });
  });

  // Sessão autenticada com sucesso (salva localmente pelo LocalAuth)
  acc.client.on('authenticated', () => {
    acc.qrDataUrl = null;
    acc.status    = 'authenticated';
    broadcastAccountUpdate();
    broadcastWaStatus({ type: 'authenticated', message: `Conta ${id}: autenticada.` });
  });

  // Falha de autenticação (sessão expirada ou celular deslogou)
  acc.client.on('auth_failure', msg => {
    acc.status = 'error';
    broadcastAccountUpdate();
    broadcastWaStatus({ type: 'error', message: `Conta ${id}: falha na autenticação: ${msg}` });
  });

  // Conta pronta para uso — carrega foto de perfil para exibição
  acc.client.on('ready', async () => {
    acc.isReady = true;
    acc.status  = 'ready';
    acc.info    = acc.client.info;
    try {
      acc.profilePicUrl = await acc.client.getProfilePicUrl(acc.info?.wid?._serialized);
    } catch {
      acc.profilePicUrl = null;
    }
    broadcastAccountUpdate();
    broadcastWaStatus({ type: 'ready', message: `Conta ${id}: conectada e pronta.` });
  });

  // Conta desconectada (logout, erro de rede ou celular offline)
  acc.client.on('disconnected', () => {
    acc.isReady       = false;
    acc.status        = 'disconnected';
    acc.client        = null;
    acc.info          = null;
    acc.profilePicUrl = null;
    broadcastAccountUpdate();
    broadcastWaStatus({ type: 'error', message: `Conta ${id}: desconectada.` });
  });

  try {
    await acc.client.initialize();
  } catch {
    acc.status = 'error';
    broadcastAccountUpdate();
  }
}

// ═══════════════════════════════════════════════════════════════
//  CONSULTA AO WHATSAPP (com timeout e retry)
// ═══════════════════════════════════════════════════════════════

/**
 * Wrapper de getNumberId com timeout de 20 segundos via Promise.race.
 * Evita que a Promise fique presa quando o frame do Puppeteer é descartado
 * durante uma recarga interna do WhatsApp Web.
 */
function getNumberIdWithTimeout(client, normalized, timeoutMs = 20000) {
  return Promise.race([
    client.getNumberId(normalized),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('getNumberId timeout')), timeoutMs)
    )
  ]);
}

/**
 * Consulta se um número está registrado no WhatsApp com até 3 tentativas.
 * Erros transitórios (frame descartado, contexto destruído, timeout) são
 * detectados e retentados após 5 segundos. Outros erros são relançados.
 *
 * @param {string} normalized  Número normalizado no formato E.164.
 */
async function getNumberIdWithRetry(normalized, clientOverride = null, maxRetries = 3, retryDelayMs = 5000) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const client = clientOverride || getNextClient();
    if (!client) throw new Error('Nenhuma conta WhatsApp conectada.');
    try {
      return await getNumberIdWithTimeout(client, normalized);
    } catch (err) {
      lastErr = err;
      const msg = err.message || String(err);
      const isTransient = msg.includes('detached Frame')
        || msg.includes('Execution context was destroyed')
        || msg.includes('Target closed')
        || msg.includes('Session closed')
        || msg.includes('getNumberId timeout');
      if (isTransient) {
        console.warn(`[getNumberId] Tentativa ${attempt + 1}/${maxRetries} falhou: ${msg.split('\n')[0]}. Aguardando ${retryDelayMs}ms...`);
        await sleep(retryDelayMs);
        continue;
      }
      throw err; // erro não recuperável — propaga imediatamente
    }
  }
  throw lastErr;
}

// ═══════════════════════════════════════════════════════════════
//  PERSISTÊNCIA DE CREDENCIAIS DO BANCO
// ═══════════════════════════════════════════════════════════════

const DB_CONFIG_PATH = () => path.join(app.getPath('userData'), 'db-config.json');

/** Salva as credenciais do banco no userData (fora do projeto/git). */
function saveDbConfig(config) {
  try {
    fs.writeFileSync(DB_CONFIG_PATH(), JSON.stringify(config), 'utf8');
  } catch (err) {
    console.warn('[saveDbConfig] Erro ao salvar credenciais do banco:', err.message);
  }
}

/** Remove as credenciais salvas (ao desconectar). */
function deleteDbConfig() {
  try {
    const p = DB_CONFIG_PATH();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (err) {
    console.warn('[deleteDbConfig] Erro ao deletar credenciais do banco:', err.message);
  }
}

/** Carrega e retorna a config salva, ou null se não existir. */
function loadDbConfig() {
  try {
    const p = DB_CONFIG_PATH();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn('[loadDbConfig] Erro ao carregar credenciais do banco:', err.message);
  }
  return null;
}

/** Tenta conectar ao banco com uma config. Retorna true se sucesso. */
async function tryConnectDb(config) {
  const newPool = new Pool({
    host:              String(config.host).trim(),
    port:              Number(config.port) || 5432,
    database:          String(config.database || 'postgres').trim(),
    user:              String(config.user).trim(),
    password:          String(config.password),
    ssl:               config.ssl ? { rejectUnauthorized: process.env.NODE_ENV === 'production' } : false,
    max:               10,
    idleTimeoutMillis: 30000
  });
  await newPool.query('SELECT 1');
  pool = newPool;
  return true;
}

// ═══════════════════════════════════════════════════════════════
//  IPC HANDLERS — Conexão com o banco
// ═══════════════════════════════════════════════════════════════

// Conecta ao banco com as credenciais fornecidas pelo usuário
ipcMain.handle('connect-db', async (_event, config) => {
  if (!config?.host || !config?.user || !config?.password) {
    return { ok: false, error: 'Host, usuário e senha são obrigatórios.' };
  }
  if (pool) {
    try { await pool.end(); } catch (err) {
      console.warn('[connect-db] Erro ao encerrar conexão anterior:', err.message);
    }
    pool = null;
  }
  try {
    await tryConnectDb(config);
    saveDbConfig(config);
    broadcastDbStatus({ connected: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Desconecta do banco e libera o pool
ipcMain.handle('disconnect-db', async () => {
  if (pool) {
    try { await pool.end(); } catch (err) {
      console.warn('[disconnect-db] Erro ao encerrar pool:', err.message);
    }
    pool = null;
  }
  deleteDbConfig();
  broadcastDbStatus({ connected: false });
  return { ok: true };
});

// Retorna se o banco está conectado
ipcMain.handle('get-db-status', () => ({ connected: pool !== null }));

// ═══════════════════════════════════════════════════════════════
//  BANCO DE DADOS — phone_cache
// ═══════════════════════════════════════════════════════════════

/**
 * Consulta o resultado de um número no cache em memória ou no banco.
 * O cache em memória (phoneCache) evita buscas repetidas durante a mesma sessão.
 *
 * @returns {{ hasWa: boolean, checkedAt: string } | null}
 *   Resultado do número ou null se ainda não foi consultado.
 */
async function lookupPhone(phone) {
  if (Object.prototype.hasOwnProperty.call(phoneCache, phone)) {
    return phoneCache[phone];
  }
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      'SELECT has_wa, checked_at FROM phone_cache WHERE phone = $1',
      [phone]
    );
    if (rows.length) {
      const entry = {
        hasWa:     rows[0].has_wa,
        checkedAt: rows[0].checked_at ? formatDate(rows[0].checked_at) : null
      };
      phoneCache[phone] = entry; // popula cache em memória
      return entry;
    }
  } catch { /* ignora erros de banco para não interromper a validação */ }
  return null;
}

/**
 * Persiste o resultado de uma consulta no banco via upsert.
 * Usa ON CONFLICT para atualizar registros existentes.
 */
async function savePhone(phone, hasWa, checkedAt) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO phone_cache (phone, has_wa, checked_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET has_wa = $2, checked_at = $3`,
      [phone, hasWa, checkedAt]
    );
  } catch { /* ignora erros de banco para não interromper a validação */ }
}

// ═══════════════════════════════════════════════════════════════
//  GERAÇÃO DE ARQUIVOS DE SAÍDA
// ═══════════════════════════════════════════════════════════════

/**
 * Gera o conteúdo do TXT e do CSV de saída a partir dos resultados da validação.
 *
 * TXT: contém somente as linhas com WhatsApp, formato: phone;variable_1;variable_2...
 * CSV: relatório completo com status de cada linha processada.
 *
 * @param {string[]} validOriginalLines  Linhas originais que passaram na validação.
 * @param {object[]} allResults          Todos os resultados incluindo inválidos e erros.
 * @param {object}   columnMapping       Mapeamento de colunas: { phone: number, variables: number[] }.
 */
function buildFileOutput(validOriginalLines, allResults, columnMapping = {}) {
  const phoneCol = columnMapping.phone     ?? 0;
  const varCols  = columnMapping.variables ?? [2]; // padrão: coluna C como variável 1

  const varHeaders = varCols.map((_, i) => `variable_${i + 1}`);
  const txtLines   = [['phone', ...varHeaders].join(';')];

  for (const line of validOriginalLines) {
    const cols     = line.split(';');
    const rawPhone = cols[phoneCol]?.trim() || '';
    const phone    = normalizePhone(rawPhone);
    const vars     = varCols.map(ci => cols[ci]?.trim() || '');
    txtLines.push([phone ? '+' + phone : rawPhone, ...vars].join(';'));
  }

  const csvLines = ['linha_original,telefone_normalizado,status,detalhes'];
  for (const r of allResults) {
    const normalizedDisplay = r.normalized ? '+' + r.normalized : r.normalized;
    csvLines.push([
      `"${String(r.line).replace(/"/g, '""')}"`,
      `"${String(normalizedDisplay).replace(/"/g, '""')}"`,
      `"${String(r.status).replace(/"/g, '""')}"`,
      `"${String(r.details).replace(/"/g, '""')}"`
    ].join(','));
  }

  return {
    txtContent: txtLines.join('\n'),
    csvContent: csvLines.join('\n')
  };
}

/**
 * Cria um arquivo ZIP com os arquivos fornecidos.
 * @param {string}   zipPath  Caminho completo do ZIP a ser criado.
 * @param {{ name: string, content: string }[]} files  Arquivos a incluir.
 */
function createZip(zipPath, files) {
  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const { name, content } of files) {
      archive.append(content, { name });
    }
    archive.finalize();
  });
}

// ═══════════════════════════════════════════════════════════════
//  JANELA PRINCIPAL
// ═══════════════════════════════════════════════════════════════

function createWindow() {
  mainWindow = new BrowserWindow({
    width:     1220,
    height:    860,
    minWidth:  1050,
    minHeight: 760,
    frame:     false,
    backgroundColor: '#c0c0c0',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });

  mainWindow.loadFile('whatsapp-validator-gui.html');

  // Ao terminar de carregar, inicia as contas salvas e reconecta o banco (se houver config salva)
  mainWindow.webContents.once('did-finish-load', () => {
    initSessionCache();
    const savedIds = loadSavedAccountIds();
    if (savedIds.length === 0) {
      startAccount('account-1').catch(err => console.error('[did-finish-load] Erro ao inicializar account-1:', err.message));
      nextAccountId = 2;
    } else {
      // Garante que o próximo ID não conflite com os existentes
      for (const id of savedIds) {
        const n = parseInt(id.replace('account-', ''), 10);
        if (!isNaN(n) && n >= nextAccountId) nextAccountId = n + 1;
      }
      for (const id of savedIds) startAccount(id).catch(err => console.error(`[did-finish-load] Erro ao inicializar ${id}:`, err.message));
    }

    // Auto-connect ao banco se houver credenciais salvas
    const savedDbConfig = loadDbConfig();
    if (savedDbConfig) {
      tryConnectDb(savedDbConfig)
        .then(() => broadcastDbStatus({ connected: true }))
        .catch(err => console.warn('[did-finish-load] Auto-conexão ao banco falhou (usuário reconecta manualmente):', err.message));
    }
  });
}

// ═══════════════════════════════════════════════════════════════
//  IPC HANDLERS — Diálogos de arquivo
// ═══════════════════════════════════════════════════════════════

// Abre o seletor de arquivo(s) TXT de entrada
ipcMain.handle('pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title:      'Selecionar arquivo(s) TXT',
    properties: ['openFile', 'multiSelections'],
    filters:    [{ name: 'Text Files', extensions: ['txt'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths.map(fp => ({
    filePath: fp,
    count: fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter(Boolean).length
  }));
});

// Abre o seletor de pasta de saída
ipcMain.handle('pick-output-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title:      'Selecionar pasta de saída',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ═══════════════════════════════════════════════════════════════
//  IPC HANDLERS — Informações de arquivo
// ═══════════════════════════════════════════════════════════════

// Retorna contagem de linhas de um ou mais arquivos
ipcMain.handle('get-file-info', (_event, filePaths) => {
  try {
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    return paths
      .filter(fp => fs.existsSync(fp) && isSafeFilePath(fp))
      .map(fp => {
        try {
          return {
            filePath: fp,
            count: fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter(Boolean).length
          };
        } catch (err) {
          console.warn('[get-file-info] Erro ao ler arquivo:', err.message);
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.error('[get-file-info] Erro geral:', err.message);
    return [];
  }
});

// Lê a primeira linha do arquivo e retorna as colunas detectadas.
// Usado pelo modal de mapeamento de colunas no frontend.
ipcMain.handle('get-file-columns', (_event, filePath) => {
  try {
    if (!fs.existsSync(filePath) || !isSafeFilePath(filePath)) {
      console.warn('[get-file-columns] Path validation failed:', filePath);
      return { columns: [] };
    }
    const firstLine = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).find(l => l.trim());
    if (!firstLine) return { columns: [] };
    const columns = firstLine.split(';').map((v, i) => ({
      index: i,
      label: `Coluna ${String.fromCharCode(65 + i)} — ${v.trim().slice(0, 40) || '(vazio)'}`
    }));
    return { columns };
  } catch (err) {
    console.error('[get-file-columns] Erro:', err.message);
    return { columns: [] };
  }
});

// ═══════════════════════════════════════════════════════════════
//  IPC HANDLERS — Contas WhatsApp
// ═══════════════════════════════════════════════════════════════

// Retorna o estado atual de todas as contas
ipcMain.handle('get-accounts', () => getAccountList());

// Retorna o QR Code da primeira conta aguardando leitura (compatibilidade legada)
ipcMain.handle('get-qr', () => ({
  qrDataUrl: [...accounts.values()].find(a => a.qrDataUrl)?.qrDataUrl || null
}));

// Adiciona e inicializa uma nova conta
ipcMain.handle('add-account', async () => {
  const id = 'account-' + (nextAccountId++);
  try {
    await startAccount(id);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Remove uma conta e destrói sua sessão
ipcMain.handle('remove-account', async (_event, id) => {
  const acc = accounts.get(id);
  if (!acc) return { ok: true };
  try { if (acc.client) await acc.client.destroy(); } catch (err) {
    console.warn(`[remove-account] Erro ao destruir cliente ${id}:`, err.message);
  }
  accounts.delete(id);
  saveAccountIds();
  broadcastWaStatus({ type: 'warn', message: `Conta ${id} removida.` });
  mainWindow?.webContents.send('wa-accounts', { type: 'account-update', accounts: getAccountList() });
  return { ok: true };
});

// Conecta ou reconecta uma conta pelo ID
ipcMain.handle('connect-whatsapp', async (_event, id) => {
  const targetId = id || (accounts.size === 0 ? 'account-1' : [...accounts.keys()][0]);
  const acc = accounts.get(targetId);
  if (acc?.isReady || acc?.client) return { ok: true }; // já conectada ou inicializando
  try {
    await startAccount(targetId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Desconecta uma conta sem removê-la
ipcMain.handle('disconnect-whatsapp', async (_event, id) => {
  const acc   = id ? accounts.get(id) : [...accounts.values()][0];
  if (!acc) return { ok: true };
  const accId = id || [...accounts.keys()][0];
  try { if (acc.client) await acc.client.destroy(); } catch (err) {
    console.warn(`[disconnect-whatsapp] Erro ao destruir cliente ${accId}:`, err.message);
  }
  acc.isReady       = false;
  acc.client        = null;
  acc.status        = 'disconnected';
  acc.info          = null;
  acc.profilePicUrl = null;
  broadcastAccountUpdate();
  broadcastWaStatus({ type: 'error', message: `Conta ${accId}: desconectada.` });
  return { ok: true };
});

// Retorna informações da conta conectada (nome, número, plataforma)
ipcMain.handle('get-wa-info', async (_event, id) => {
  const acc = id ? accounts.get(id) : [...accounts.values()].find(a => a.isReady);
  if (!acc?.isReady) return { connected: false };
  return {
    connected:     true,
    name:          acc.info?.pushname || '',
    phone:         acc.info?.wid?.user || '',
    platform:      acc.info?.platform || '',
    profilePicUrl: acc.profilePicUrl || null
  };
});

// Abre o WhatsApp Web no Microsoft Edge (para referência do usuário)
ipcMain.handle('open-whatsapp-web', () => {
  const { spawn } = require('child_process');
  const edgePath  = fs.existsSync(EDGE_PATH_X86) ? EDGE_PATH_X86 : EDGE_PATH_X64;
  spawn(edgePath, ['https://web.whatsapp.com'], { detached: true, stdio: 'ignore' }).unref();
});

// ═══════════════════════════════════════════════════════════════
//  IPC HANDLERS — Janelas secundárias
// ═══════════════════════════════════════════════════════════════

// Abre (ou foca) a janela "Banco de Telefones"
ipcMain.handle('open-banco-window', () => {
  if (bancoWindow && !bancoWindow.isDestroyed()) { bancoWindow.focus(); return; }
  bancoWindow = new BrowserWindow({
    width: 960, height: 720, minWidth: 700, minHeight: 500,
    frame: false,
    backgroundColor: '#c0c0c0',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    title: 'Banco de Telefones',
    parent: mainWindow,
    webPreferences: {
      preload:          path.join(__dirname, 'preload-banco.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });
  bancoWindow.loadFile('banco-telefones.html');
  bancoWindow.on('closed', () => { bancoWindow = null; });
});

// Abre (ou foca) a janela de conexão WhatsApp
ipcMain.handle('open-connect-window', () => {
  if (connectWindow && !connectWindow.isDestroyed()) { connectWindow.focus(); return; }
  connectWindow = new BrowserWindow({
    width: 400, height: 540, resizable: false,
    frame: false,
    backgroundColor: '#c0c0c0',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    title: 'Conexão WhatsApp',
    parent: mainWindow,
    webPreferences: {
      preload:          path.join(__dirname, 'preload-connect.js'),
      contextIsolation: true,
      nodeIntegration:  false
    }
  });
  connectWindow.loadFile('whatsapp-connect.html');
  connectWindow.on('closed', () => { connectWindow = null; });
});

// Abre o Explorer na pasta do arquivo indicado
ipcMain.handle('open-path', (_event, p) => {
  shell.showItemInFolder(p);
});

// ═══════════════════════════════════════════════════════════════
//  IPC HANDLERS — Banco de dados (phone_cache)
// ═══════════════════════════════════════════════════════════════

// Retorna o total de números armazenados no banco
ipcMain.handle('get-cache-info', async () => {
  if (!pool) return { count: 0, error: 'Banco não conectado.' };
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS total FROM phone_cache');
    return { count: Number(rows[0].total) };
  } catch (err) {
    console.error('[get-cache-info] Erro:', err.message);
    return { count: 0, error: err.message };
  }
});

// Pesquisa paginada no banco com filtros de número e status de WhatsApp
ipcMain.handle('search-cache', async (_event, query, filter, offset = 0, pageSize = 100) => {
  if (!pool) return { rows: [], total: 0, error: 'Banco não conectado.' };
  try {
    const q      = String(query || '').replace(/\D/g, '');
    const params = [];
    let where    = '1=1';

    if (q) {
      params.push(`%${q}%`);
      where += ` AND phone LIKE $${params.length}`;
    }
    if (filter === 'true')  where += ' AND has_wa = true';
    if (filter === 'false') where += ' AND has_wa = false';

    const countRes = await pool.query(
      `SELECT COUNT(*) AS total FROM phone_cache WHERE ${where}`,
      params
    );
    const total = Number(countRes.rows[0].total);

    const dataParams = [...params, Number(pageSize), Number(offset)];
    const { rows } = await pool.query(
      `SELECT phone, has_wa, checked_at FROM phone_cache
       WHERE ${where} ORDER BY phone
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    return {
      rows: rows.map(r => ({
        phone:     r.phone,
        hasWa:     r.has_wa,
        checkedAt: r.checked_at ? formatDate(r.checked_at) : null
      })),
      total
    };
  } catch (err) {
    console.error('[search-cache] Erro:', err.message);
    return { rows: [], total: 0, error: err.message };
  }
});

// Reconsulta um número específico no WhatsApp e atualiza o banco
ipcMain.handle('revalidate-phone', async (_event, phone) => {
  if (!pool) return { ok: false, error: 'Banco não conectado.' };
  try {
    const result    = await getNumberIdWithRetry(phone);
    const exists    = !!result;
    const checkedAt = nowBRT();
    phoneCache[phone] = { hasWa: exists, checkedAt };
    await savePhone(phone, exists, checkedAt);
    return { ok: true, phone, hasWa: exists, checkedAt };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// ═══════════════════════════════════════════════════════════════
//  IPC HANDLER — Controle da validação em lote
// ═══════════════════════════════════════════════════════════════

// Sinaliza ao loop de validação que deve interromper na próxima iteração
ipcMain.handle('cancel-validation', async () => {
  cancelRequested = true;
  return { ok: true };
});

// Retorna o ponto de retomada atual (para a funcionalidade "Pausar")
ipcMain.handle('get-resume-state', () => ({
  has:       resumeState !== null,
  inputPath: resumeState?.inputPath  || null,
  processed: resumeState?.startIndex || 0
}));

/**
 * Executa a validação em lote de um ou mais arquivos TXT.
 *
 * Fluxo de decisão por telefone:
 *   1. Formato inválido        → registra "formato_invalido", pula.
 *   2. No banco (sem force)    → usa resultado salvo, sem consultar WhatsApp.
 *   3. bankOnly e não no banco → registra "sem_dados", pula.
 *   4. Padrão                  → consulta WhatsApp, salva resultado, aplica delay.
 *
 * Recursos:
 *   - Múltiplos arquivos processados em sequência.
 *   - Pausar/Retomar via resumeFrom + resumeState.
 *   - Pausa automática entre lotes (batchSize/batchPauseMs).
 *   - Mapeamento customizável de colunas (columnMapping).
 */
ipcMain.handle('start-validation', async (_event, payload) => {
  try {
    const {
      inputPaths,
      minDelayMs    = 2000,
      maxDelayMs    = 5000,
      batchSize     = 150,
      batchPauseMs  = 30000,
      resumeFrom    = false,
      outputDir:    payloadOutputDir = '',
      forceRevalidate = false,
      bankOnly        = false,
      columnMapping   = {}
    } = payload;

    // Modo padrão requer ao menos uma conta conectada
    if (!bankOnly && getConnectedClients().length === 0) {
      return { ok: false, error: 'Nenhuma conta WhatsApp conectada.' };
    }
    if (!inputPaths?.length) return { ok: false, error: 'Nenhum arquivo selecionado.' };

    cancelRequested = false;

    // Garante que a pasta de saída padrão existe
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const resolvedOutputDir = (payloadOutputDir && fs.existsSync(payloadOutputDir))
      ? payloadOutputDir
      : OUTPUT_DIR;

    // ── Inicializa ou restaura estado de retomada ──────────────
    let startFileIndex    = 0;
    let startLineIndex    = 0;
    let completedZipFiles = [];
    let currentAllResults = [];
    let currentValidLines = [];
    let processedInBatch  = 0;
    let totalValid        = 0;

    if (resumeFrom && resumeState && JSON.stringify(resumeState.inputPaths) === JSON.stringify(inputPaths)) {
      startFileIndex    = resumeState.fileIndex;
      startLineIndex    = resumeState.startIndex;
      completedZipFiles = resumeState.completedZipFiles  || [];
      currentAllResults = resumeState.allResults         || [];
      currentValidLines = resumeState.validOriginalLines || [];
      processedInBatch  = resumeState.processedInBatch   || 0;
      totalValid        = resumeState.totalValid          || 0;
      resumeState = null;
    } else {
      resumeState = null;
      initSessionCache();
    }

    // ── Pré-computa totais para a barra de progresso global ────
    const fileLinesCount = inputPaths.map(p => {
      try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(Boolean).length; }
      catch { return 0; }
    });
    const globalTotal   = fileLinesCount.reduce((a, b) => a + b, 0);
    let   globalCurrent = fileLinesCount.slice(0, startFileIndex).reduce((a, b) => a + b, 0) + startLineIndex;

    const allZipFiles = [...completedZipFiles];

    // ── Loop principal: itera sobre cada arquivo selecionado ───
    for (let fileIdx = startFileIndex; fileIdx < inputPaths.length; fileIdx++) {
      const inputPath = inputPaths[fileIdx];
      const fileName  = path.basename(inputPath);
      if (!fs.existsSync(inputPath)) continue;

      const exportBase = path.basename(inputPath, path.extname(inputPath)) + '_validado';
      const rawLines   = fs.readFileSync(inputPath, 'utf8')
        .split(/\r?\n/).map(x => x.trim()).filter(Boolean);

      // Ao retomar, preserva resultados parciais do arquivo em curso
      const lineStart        = fileIdx === startFileIndex ? startLineIndex    : 0;

      // ── Loop paralelo: um worker por conta WhatsApp conectada ─
      const connectedAccts  = bankOnly ? [] : getConnectedClients();
      const lineResults     = new Array(rawLines.length).fill(undefined);

      // Pré-preenche com resultados do resume (linhas já processadas)
      const priorResults = fileIdx === startFileIndex ? currentAllResults : [];
      for (let k = 0; k < lineStart; k++) lineResults[k] = priorResults[k];

      let nextIdx            = lineStart;
      let processedRealCount = fileIdx === startFileIndex ? processedInBatch : 0;
      let batchPausePromise  = null;

      const runWorker = async (client) => {
        await validationSemaphore.acquire();
        try {
          while (true) {
            if (cancelRequested) break;
            if (batchPausePromise) await batchPausePromise;
            if (cancelRequested) break;

          const myIdx = nextIdx++;
          if (myIdx >= rawLines.length) break;

          const originalLine = rawLines[myIdx];
          const normalized   = extractPhoneFromLine(originalLine, columnMapping.phone ?? 0);
          let row;

          if (!normalized) {
            row = {
              line: originalLine, normalized: '',
              status:  'formato_invalido',
              details: 'Primeira coluna não contém telefone válido'
            };
          } else if (!forceRevalidate && await lookupPhone(normalized)) {
            const { hasWa: exists } = phoneCache[normalized];
            row = {
              line: originalLine, normalized,
              status:    exists ? 'tem_whatsapp' : 'sem_whatsapp',
              details:   (exists ? 'Registrado no WhatsApp' : 'Não registrado') + ' (banco)',
              fromCache: true
            };
          } else if (bankOnly) {
            row = {
              line: originalLine, normalized,
              status: 'sem_dados', details: 'Não encontrado no banco',
              fromCache: true
            };
          } else {
            try {
              const result    = await getNumberIdWithRetry(normalized, client);
              const exists    = !!result;
              const checkedAt = nowBRT();
              phoneCache[normalized] = { hasWa: exists, checkedAt };
              await savePhone(normalized, exists, checkedAt);
              row = {
                line: originalLine, normalized,
                status:  exists ? 'tem_whatsapp' : 'sem_whatsapp',
                details: exists ? 'Registrado no WhatsApp' : 'Não registrado'
              };
            } catch (err) {
              row = {
                line: originalLine, normalized,
                status:  'erro',
                details: (err.message || String(err)).replace(/[\r\n]+/g, ' ')
              };
            }
          }

          lineResults[myIdx] = row;
          globalCurrent++;

          mainWindow?.webContents.send('validation-progress', {
            current:    globalCurrent,
            total:      globalTotal,
            fileIndex:  fileIdx,
            fileCount:  inputPaths.length,
            fileName,
            row,
            batchCount: processedRealCount,
            batchSize:  Number(batchSize)
          });

          if (!row.fromCache) {
            const moreItems = nextIdx < rawLines.length;
            if (moreItems) {
              processedRealCount++;
              if (processedRealCount >= Number(batchSize) && !batchPausePromise) {
                broadcastWaStatus({ type: 'pause', message: `Pausa de lote por ${batchPauseMs}ms.` });
                processedRealCount = 0;
                batchPausePromise = sleep(Number(batchPauseMs)).then(() => { batchPausePromise = null; });
              } else if (!batchPausePromise) {
                await sleep(randBetween(minDelayMs, maxDelayMs));
              }
            }
          }
          }
        } finally {
          validationSemaphore.release();
        }
      };

      await Promise.all(
        connectedAccts.length
          ? connectedAccts.map(acc => runWorker(acc.client))
          : [runWorker(null)]
      );

      // ── Cancel/Pause: salva ponto de retomada ─────────────────
      if (cancelRequested) {
        const partialAllResults = lineResults.filter(r => r !== undefined);
        const partialValidLines = partialAllResults
          .filter(r => r.status === 'tem_whatsapp').map(r => r.line);

        resumeState = {
          inputPaths,
          fileIndex:          fileIdx,
          startIndex:         partialAllResults.length,
          allResults:         partialAllResults,
          validOriginalLines: partialValidLines,
          processedInBatch:   processedRealCount,
          totalValid,
          completedZipFiles:  [...allZipFiles]
        };

        let partialZip = null;
        try {
          const ts           = makeTimestamp();
          partialZip         = path.join(resolvedOutputDir, `validados_parcial_${ts}.zip`);
          const partialFiles = [...allZipFiles];
          const { txtContent, csvContent } = buildFileOutput(partialValidLines, partialAllResults, columnMapping);
          partialFiles.push({ name: `${exportBase}_parcial.txt`, content: txtContent });
          partialFiles.push({ name: `${exportBase}_parcial.csv`, content: csvContent });
          if (partialFiles.length) await createZip(partialZip, partialFiles);
        } catch (err) {
          console.warn('[start-validation] Erro ao criar ZIP parcial:', err.message);
          partialZip = null;
        }

        return {
          ok: true, canceled: true,
          total:     globalTotal,
          processed: globalCurrent,
          valid:     totalValid + partialValidLines.length,
          partialZip
        };
      }

      // Constrói resultados ordenados do arquivo
      const allResults         = lineResults.filter(r => r !== undefined);
      const validOriginalLines = allResults.filter(r => r.status === 'tem_whatsapp').map(r => r.line);

      // Arquivo concluído — adiciona TXT e CSV ao ZIP final
      totalValid += validOriginalLines.length;
      const { txtContent, csvContent } = buildFileOutput(validOriginalLines, allResults, columnMapping);
      allZipFiles.push({ name: `${exportBase}.txt`, content: txtContent });
      allZipFiles.push({ name: `${exportBase}.csv`, content: csvContent });

    } // fim loop de arquivos

    resumeState = null;

    // Empacota todos os arquivos gerados em um único ZIP
    const ts      = makeTimestamp();
    const zipName = inputPaths.length === 1
      ? `${path.basename(inputPaths[0], path.extname(inputPaths[0]))}_validado_${ts}.zip`
      : `validados_${ts}.zip`;
    const zipOut = path.join(resolvedOutputDir, zipName);
    await createZip(zipOut, allZipFiles);

    return { ok: true, zipOut, total: globalTotal, valid: totalValid };

  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// ═══════════════════════════════════════════════════════════════
//  IPC HANDLER — Validação manual (campo "Validação rápida")
// ═══════════════════════════════════════════════════════════════

ipcMain.handle('validate-phones-manual', async (_event, phones) => {
  if (getConnectedClients().length === 0) {
    return { ok: false, error: 'Nenhuma conta WhatsApp conectada.' };
  }
  const results = [];
  for (const phone of phones) {
    const normalized = normalizePhone(phone);
    if (!normalized) {
      results.push({ input: phone, normalized: '', hasWa: null, error: 'Formato inválido' });
      continue;
    }
    try {
      const result    = await getNumberIdWithRetry(normalized);
      const exists    = !!result;
      const checkedAt = nowBRT();
      phoneCache[normalized] = { hasWa: exists, checkedAt };
      await savePhone(normalized, exists, checkedAt);
      results.push({ input: phone, normalized, hasWa: exists, checkedAt });
    } catch (err) {
      results.push({
        input: phone, normalized, hasWa: null,
        error: (err.message || String(err)).replace(/[\r\n]+/g, ' ')
      });
    }
  }
  return { ok: true, results };
});

// ═══════════════════════════════════════════════════════════════
//  CICLO DE VIDA DA APLICAÇÃO
// ═══════════════════════════════════════════════════════════════

// ── Controles da janela (frameless) ──────────────────────────
ipcMain.on('win-minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('win-maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win?.isMaximized()) win.unmaximize(); else win?.maximize();
});
ipcMain.on('win-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.handle('get-app-version', () => app.getVersion());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});

// Encerra todas as sessões do WhatsApp antes de fechar o app
let isQuitting = false;
app.on('before-quit', async e => {
  if (!isQuitting) {
    const connected = getConnectedClients();
    if (connected.length > 0) {
      e.preventDefault();
      isQuitting = true;
      for (const [id, acc] of accounts) {
        try { if (acc.client) await acc.client.destroy(); } catch (err) {
          console.warn(`[before-quit] Erro ao destruir cliente ${id}:`, err.message);
        }
      }
      app.quit();
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
