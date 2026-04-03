const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const archiver = require('archiver');
const { Pool } = require('pg');
const QRCode = require('qrcode');

function formatDate(d) {
  // Formata a data como está, sem ajuste de fuso — o banco já armazena em BRT
  const dt = d instanceof Date ? d : new Date(d);
  const p = n => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth()+1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
}

function nowBRT() {
  // Hora atual em UTC-3 (América/São_Paulo)
  return formatDate(new Date(Date.now() - 3 * 60 * 60 * 1000));
}
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const dbConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'db-config.json'), 'utf8'));
const pool = new Pool(dbConfig);

let mainWindow;
let bancoWindow = null;
let connectWindow = null;
let cancelRequested = false;
let resumeState = null;
let phoneCache = null;

// Multi-account state
// accounts: Map<id, { client, isReady, qrDataUrl, info }>
const accounts = new Map();
let rrIndex = 0; // round-robin cursor
let nextAccountId = 1;

function broadcastWaStatus(data) {
  mainWindow?.webContents.send('wa-status', data);
  if (connectWindow && !connectWindow.isDestroyed()) {
    connectWindow.webContents.send('wa-status', data);
  }
}

function broadcastAccountUpdate(id) {
  const acc = accounts.get(id);
  if (!acc) return;
  const info = acc.isReady ? {
    name: acc.info?.pushname || '',
    phone: acc.info?.wid?.user || '',
    platform: acc.info?.platform || '',
    profilePicUrl: acc.profilePicUrl || null
  } : null;
  const payload = {
    type: 'account-update',
    accounts: getAccountList()
  };
  mainWindow?.webContents.send('wa-accounts', payload);
}

function getAccountList() {
  return [...accounts.entries()].map(([id, acc]) => ({
    id,
    isReady: acc.isReady,
    qrDataUrl: acc.qrDataUrl || null,
    name: acc.info?.pushname || '',
    phone: acc.info?.wid?.user || '',
    platform: acc.info?.platform || '',
    profilePicUrl: acc.profilePicUrl || null,
    status: acc.status || 'disconnected'
  }));
}

function getConnectedClients() {
  return [...accounts.values()].filter(a => a.isReady && a.client);
}

function getNextClient() {
  const connected = getConnectedClients();
  if (!connected.length) return null;
  rrIndex = rrIndex % connected.length;
  const acc = connected[rrIndex];
  rrIndex = (rrIndex + 1) % connected.length;
  return acc.client;
}

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 8) return '';
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits;
  if (digits.length === 10 || digits.length === 11) return '55' + digits;
  return digits;
}

function extractPhoneFromLine(line) {
  if (!line || !line.trim()) return '';
  const firstColumn = line.split(';')[0]?.trim() || '';
  return normalizePhone(firstColumn);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randBetween(min, max) {
  const a = Number(min) || 0;
  const b = Number(max) || 0;
  if (b <= a) return a;
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

function initSessionCache() {
  phoneCache = {};
}

function getNumberIdWithTimeout(client, normalized, timeoutMs = 20000) {
  return Promise.race([
    client.getNumberId(normalized),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('getNumberId timeout')), timeoutMs)
    )
  ]);
}

async function getNumberIdWithRetry(normalized, maxRetries = 3, retryDelayMs = 5000) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const activeClient = getNextClient();
    if (!activeClient) throw new Error('Nenhuma conta WhatsApp conectada.');
    try {
      return await getNumberIdWithTimeout(activeClient, normalized);
    } catch (err) {
      lastErr = err;
      const msg = err.message || String(err);
      const isTransient = msg.includes('detached Frame')
        || msg.includes('Execution context was destroyed')
        || msg.includes('Target closed')
        || msg.includes('Session closed')
        || msg.includes('getNumberId timeout');
      if (isTransient) {
        console.warn(`[getNumberId] Tentativa ${attempt + 1}/${maxRetries} falhou (${msg.split('\n')[0]}). Aguardando ${retryDelayMs}ms...`);
        await sleep(retryDelayMs);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function lookupPhone(phone) {
  if (Object.prototype.hasOwnProperty.call(phoneCache, phone)) {
    return phoneCache[phone];
  }
  try {
    const { rows } = await pool.query(
      'SELECT has_wa, checked_at FROM phone_cache WHERE phone = $1',
      [phone]
    );
    if (rows.length) {
      const entry = { hasWa: rows[0].has_wa, checkedAt: rows[0].checked_at ? formatDate(rows[0].checked_at) : null };
      phoneCache[phone] = entry;
      return entry;
    }
  } catch { /* ignore */ }
  return null;
}

async function savePhone(phone, hasWa, checkedAt) {
  try {
    await pool.query(
      `INSERT INTO phone_cache (phone, has_wa, checked_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET has_wa = $2, checked_at = $3`,
      [phone, hasWa, checkedAt]
    );
  } catch { /* ignore */ }
}

function makeTimestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function buildFileOutput(validOriginalLines, allResults) {
  const txtLines = ['phone;variable_1'];
  for (const line of validOriginalLines) {
    const cols = line.split(';');
    const colA = cols[0]?.trim() || '';
    const colC = cols[2]?.trim() || '';
    const phone = normalizePhone(colA);
    txtLines.push(`${phone ? '+' + phone : colA};${colC}`);
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
  return { txtContent: txtLines.join('\n'), csvContent: csvLines.join('\n') };
}

function createZip(zipPath, files) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 1050,
    minHeight: 760,
    backgroundColor: '#f4f7f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('whatsapp-validator-gui.html');
  mainWindow.webContents.once('did-finish-load', () => {
    initSessionCache();
    // Auto-connect saved accounts
    const savedIds = loadSavedAccountIds();
    if (savedIds.length === 0) {
      // Start a default account
      startAccount('account-1').catch(() => {});
      nextAccountId = 2;
    } else {
      // Update nextAccountId to avoid collisions
      for (const id of savedIds) {
        const n = parseInt(id.replace('account-', ''), 10);
        if (!isNaN(n) && n >= nextAccountId) nextAccountId = n + 1;
      }
      for (const id of savedIds) {
        startAccount(id).catch(() => {});
      }
    }
  });
}

function loadSavedAccountIds() {
  try {
    const p = path.join(app.getPath('userData'), 'wa-accounts.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return [];
}

function saveAccountIds() {
  try {
    const p = path.join(app.getPath('userData'), 'wa-accounts.json');
    fs.writeFileSync(p, JSON.stringify([...accounts.keys()]), 'utf8');
  } catch {}
}

async function startAccount(id) {
  if (accounts.has(id)) return;
  const acc = { client: null, isReady: false, qrDataUrl: null, info: null, profilePicUrl: null, status: 'connecting' };
  accounts.set(id, acc);
  saveAccountIds();

  const sessionPath = path.join(app.getPath('userData'), 'wwebjs-session-' + id);
  acc.client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath, clientId: id }),
    puppeteer: {
      headless: true,
      executablePath: EDGE_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  acc.client.on('qr', async (qrString) => {
    try { acc.qrDataUrl = await QRCode.toDataURL(qrString, { margin: 1, width: 280 }); }
    catch { acc.qrDataUrl = null; }
    acc.status = 'qr';
    broadcastAccountUpdate(id);
    broadcastWaStatus({ type: 'qr', message: `Conta ${id}: leia o QR Code.` });
  });

  acc.client.on('authenticated', () => {
    acc.qrDataUrl = null;
    acc.status = 'authenticated';
    broadcastAccountUpdate(id);
    broadcastWaStatus({ type: 'authenticated', message: `Conta ${id}: autenticada.` });
  });

  acc.client.on('auth_failure', msg => {
    acc.status = 'error';
    broadcastAccountUpdate(id);
    broadcastWaStatus({ type: 'error', message: `Conta ${id}: falha na autenticação: ${msg}` });
  });

  acc.client.on('ready', async () => {
    acc.isReady = true;
    acc.status = 'ready';
    acc.info = acc.client.info;
    try { acc.profilePicUrl = await acc.client.getProfilePicUrl(acc.info?.wid?._serialized); } catch { acc.profilePicUrl = null; }
    broadcastAccountUpdate(id);
    broadcastWaStatus({ type: 'ready', message: `Conta ${id}: conectada e pronta.` });
  });

  acc.client.on('disconnected', () => {
    acc.isReady = false;
    acc.status = 'disconnected';
    acc.client = null;
    acc.info = null;
    acc.profilePicUrl = null;
    broadcastAccountUpdate(id);
    broadcastWaStatus({ type: 'error', message: `Conta ${id}: desconectada.` });
  });

  try {
    await acc.client.initialize();
  } catch (err) {
    acc.status = 'error';
    broadcastAccountUpdate(id);
  }
}

ipcMain.handle('pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecionar arquivo(s) TXT',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Text Files', extensions: ['txt'] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths.map(fp => ({
    filePath: fp,
    count: fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter(Boolean).length
  }));
});

ipcMain.handle('pick-output-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecionar pasta de saída',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('get-qr', () => ({
  // legacy single-account compatibility — returns first pending QR
  qrDataUrl: [...accounts.values()].find(a => a.qrDataUrl)?.qrDataUrl || null
}));

ipcMain.handle('get-accounts', () => getAccountList());

ipcMain.handle('add-account', async () => {
  const id = 'account-' + (nextAccountId++);
  try {
    await startAccount(id);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('remove-account', async (_event, id) => {
  const acc = accounts.get(id);
  if (!acc) return { ok: true };
  try { if (acc.client) await acc.client.destroy(); } catch {}
  accounts.delete(id);
  saveAccountIds();
  broadcastWaStatus({ type: 'warn', message: `Conta ${id} removida.` });
  mainWindow?.webContents.send('wa-accounts', { type: 'account-update', accounts: getAccountList() });
  return { ok: true };
});

ipcMain.handle('connect-whatsapp', async (_event, id) => {
  const targetId = id || (accounts.size === 0 ? 'account-1' : [...accounts.keys()][0]);
  const acc = accounts.get(targetId);
  if (acc && acc.isReady) return { ok: true };
  if (acc && acc.client) return { ok: true }; // already initializing
  try {
    await startAccount(targetId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('disconnect-whatsapp', async (_event, id) => {
  const acc = id ? accounts.get(id) : [...accounts.values()][0];
  if (!acc) return { ok: true };
  const accId = id || [...accounts.keys()][0];
  try {
    if (acc.client) await acc.client.destroy();
  } catch {}
  acc.isReady = false;
  acc.client = null;
  acc.status = 'disconnected';
  acc.info = null;
  acc.profilePicUrl = null;
  broadcastAccountUpdate(accId);
  broadcastWaStatus({ type: 'error', message: `Conta ${accId}: desconectada.` });
  return { ok: true };
});

ipcMain.handle('open-whatsapp-web', () => {
  const { spawn } = require('child_process');
  const edgePath = fs.existsSync(EDGE_PATH)
    ? EDGE_PATH
    : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
  spawn(edgePath, ['https://web.whatsapp.com'], { detached: true, stdio: 'ignore' }).unref();
});

ipcMain.handle('cancel-validation', async () => {
  cancelRequested = true;
  return { ok: true };
});

ipcMain.handle('get-resume-state', () => ({
  has: resumeState !== null,
  inputPath: resumeState?.inputPath || null,
  processed: resumeState?.startIndex || 0
}));

ipcMain.handle('search-cache', async (_event, query, filter, offset = 0, pageSize = 100) => {
  try {
    const q = String(query || '').replace(/\D/g, '');
    const params = [];
    let where = '1=1';
    if (q) { params.push(`%${q}%`); where += ` AND phone LIKE $${params.length}`; }
    if (filter === 'true') where += ' AND has_wa = true';
    else if (filter === 'false') where += ' AND has_wa = false';

    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM phone_cache WHERE ${where}`, params);
    const total = Number(countRes.rows[0].total);

    const dataParams = [...params, Number(pageSize), Number(offset)];
    const { rows } = await pool.query(
      `SELECT phone, has_wa, checked_at FROM phone_cache WHERE ${where} ORDER BY phone LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );
    return {
      rows: rows.map(r => ({ phone: r.phone, hasWa: r.has_wa, checkedAt: r.checked_at ? formatDate(r.checked_at) : null })),
      total
    };
  } catch (err) {
    console.error('[search-cache] Erro ao consultar banco:', err.message || err);
    return { rows: [], total: 0, error: err.message || String(err) };
  }
});

ipcMain.handle('open-connect-window', () => {
  if (connectWindow && !connectWindow.isDestroyed()) {
    connectWindow.focus();
    return;
  }
  connectWindow = new BrowserWindow({
    width: 400,
    height: 540,
    resizable: false,
    backgroundColor: '#f4f7f8',
    title: 'Conexão WhatsApp',
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload-connect.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  connectWindow.loadFile('whatsapp-connect.html');
  connectWindow.on('closed', () => { connectWindow = null; });
});

ipcMain.handle('get-wa-info', async (_event, id) => {
  const acc = id ? accounts.get(id) : [...accounts.values()].find(a => a.isReady);
  if (!acc || !acc.isReady) return { connected: false };
  return {
    connected: true,
    name: acc.info?.pushname || '',
    phone: acc.info?.wid?.user || '',
    platform: acc.info?.platform || '',
    profilePicUrl: acc.profilePicUrl || null
  };
});

ipcMain.handle('open-banco-window', () => {
  if (bancoWindow && !bancoWindow.isDestroyed()) {
    bancoWindow.focus();
    return;
  }
  bancoWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#f4f7f8',
    title: 'Banco de Telefones',
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload-banco.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  bancoWindow.loadFile('banco-telefones.html');
  bancoWindow.on('closed', () => { bancoWindow = null; });
});

ipcMain.handle('open-path', (_event, p) => {
  shell.showItemInFolder(p);
});

ipcMain.handle('get-cache-info', async () => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS total FROM phone_cache');
    return { count: Number(rows[0].total) };
  } catch (err) {
    console.error('[get-cache-info] Erro ao consultar banco:', err.message || err);
    return { count: 0, error: err.message || String(err) };
  }
});

ipcMain.handle('start-validation', async (_event, payload) => {
  try {
    if (getConnectedClients().length === 0) return { ok: false, error: 'Nenhuma conta WhatsApp conectada.' };
    cancelRequested = false;

    const {
      inputPaths,
      minDelayMs = 2000,
      maxDelayMs = 5000,
      batchSize = 150,
      batchPauseMs = 30000,
      resumeFrom = false,
      outputDir: payloadOutputDir = '',
      forceRevalidate = false,
      bankOnly = false
    } = payload;

    if (!inputPaths || !inputPaths.length) return { ok: false, error: 'Nenhum arquivo selecionado.' };

    const defaultOutputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(defaultOutputDir)) fs.mkdirSync(defaultOutputDir, { recursive: true });

    const resolvedOutputDir = (payloadOutputDir && fs.existsSync(payloadOutputDir))
      ? payloadOutputDir
      : defaultOutputDir;

    // Resume state
    let startFileIndex = 0;
    let startLineIndex = 0;
    let completedZipFiles = [];
    let currentAllResults = [];
    let currentValidLines = [];
    let processedInBatch = 0;
    let totalValid = 0;

    if (resumeFrom && resumeState && JSON.stringify(resumeState.inputPaths) === JSON.stringify(inputPaths)) {
      startFileIndex = resumeState.fileIndex;
      startLineIndex = resumeState.startIndex;
      completedZipFiles = resumeState.completedZipFiles || [];
      currentAllResults = resumeState.allResults || [];
      currentValidLines = resumeState.validOriginalLines || [];
      processedInBatch = resumeState.processedInBatch || 0;
      totalValid = resumeState.totalValid || 0;
      resumeState = null;
    } else {
      resumeState = null;
      initSessionCache();
    }

    // Precompute line counts for global progress bar
    const fileLinesCount = inputPaths.map(p => {
      try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(Boolean).length; }
      catch { return 0; }
    });
    const globalTotal = fileLinesCount.reduce((a, b) => a + b, 0);
    let globalCurrent = fileLinesCount.slice(0, startFileIndex).reduce((a, b) => a + b, 0) + startLineIndex;

    const allZipFiles = [...completedZipFiles];

    for (let fileIdx = startFileIndex; fileIdx < inputPaths.length; fileIdx++) {
      const inputPath = inputPaths[fileIdx];
      const fileName = path.basename(inputPath);
      if (!fs.existsSync(inputPath)) continue;

      const exportBase = path.basename(inputPath, path.extname(inputPath)) + '_validado';
      const rawLines = fs.readFileSync(inputPath, 'utf8')
        .split(/\r?\n/).map(x => x.trim()).filter(Boolean);

      let allResults = (fileIdx === startFileIndex) ? currentAllResults : [];
      let validOriginalLines = (fileIdx === startFileIndex) ? currentValidLines : [];
      const lineStart = (fileIdx === startFileIndex) ? startLineIndex : 0;
      if (fileIdx !== startFileIndex) processedInBatch = 0;

      for (let i = lineStart; i < rawLines.length; i++) {
        if (cancelRequested) {
          resumeState = {
            inputPaths,
            fileIndex: fileIdx,
            startIndex: i,
            allResults: [...allResults],
            validOriginalLines: [...validOriginalLines],
            processedInBatch,
            totalValid,
            completedZipFiles: [...allZipFiles]
          };

          let partialZip = null;
          try {
            const ts = makeTimestamp();
            partialZip = path.join(resolvedOutputDir, `validados_parcial_${ts}.zip`);
            const partialFiles = [...allZipFiles];
            const { txtContent, csvContent } = buildFileOutput(validOriginalLines, allResults);
            partialFiles.push({ name: `${exportBase}_parcial.txt`, content: txtContent });
            partialFiles.push({ name: `${exportBase}_parcial.csv`, content: csvContent });
            if (partialFiles.length) await createZip(partialZip, partialFiles);
          } catch { partialZip = null; }

          return { ok: true, canceled: true, total: globalTotal, processed: globalCurrent, valid: totalValid + validOriginalLines.length, partialZip };
        }

        const originalLine = rawLines[i];
        const normalized = extractPhoneFromLine(originalLine);
        let row;

        if (!normalized) {
          row = { line: originalLine, normalized: '', status: 'formato_invalido', details: 'Primeira coluna não contém telefone válido' };
        } else if (!forceRevalidate && await lookupPhone(normalized)) {
          const { hasWa: exists } = phoneCache[normalized];
          row = {
            line: originalLine, normalized,
            status: exists ? 'tem_whatsapp' : 'sem_whatsapp',
            details: (exists ? 'Registrado no WhatsApp' : 'Não registrado') + ' (banco)',
            fromCache: true
          };
          if (exists) validOriginalLines.push(originalLine);
        } else if (bankOnly) {
          row = { line: originalLine, normalized, status: 'sem_dados', details: 'Não encontrado no banco', fromCache: true };
        } else {
          try {
            const result = await getNumberIdWithRetry(normalized);
            const exists = !!result;
            const checkedAt = nowBRT();
            phoneCache[normalized] = { hasWa: exists, checkedAt };
            await savePhone(normalized, exists, checkedAt);
            row = {
              line: originalLine, normalized,
              status: exists ? 'tem_whatsapp' : 'sem_whatsapp',
              details: exists ? 'Registrado no WhatsApp' : 'Não registrado'
            };
            if (exists) validOriginalLines.push(originalLine);
          } catch (err) {
            row = { line: originalLine, normalized, status: 'erro', details: (err.message || String(err)).replace(/[\r\n]+/g, ' ') };
          }
        }

        allResults.push(row);
        if (!row.fromCache) processedInBatch += 1;
        globalCurrent++;

        mainWindow?.webContents.send('validation-progress', {
          current: globalCurrent,
          total: globalTotal,
          fileIndex: fileIdx,
          fileCount: inputPaths.length,
          fileName,
          row,
          batchCount: processedInBatch,
          batchSize: Number(batchSize)
        });

        if (!row.fromCache) {
          const isLastOfFile = i === rawLines.length - 1;
          const isLastFile = fileIdx === inputPaths.length - 1;
          if (!isLastOfFile || !isLastFile) {
            if (processedInBatch >= Number(batchSize)) {
              broadcastWaStatus({
                type: 'pause',
                message: `Pausa de lote iniciada por ${batchPauseMs} ms.`
              });
              await sleep(Number(batchPauseMs));
              processedInBatch = 0;
            } else {
              await sleep(randBetween(minDelayMs, maxDelayMs));
            }
          }
        }
      }

      // File complete — add its output to the zip
      totalValid += validOriginalLines.length;
      const { txtContent, csvContent } = buildFileOutput(validOriginalLines, allResults);
      allZipFiles.push({ name: `${exportBase}.txt`, content: txtContent });
      allZipFiles.push({ name: `${exportBase}.csv`, content: csvContent });
    }

    resumeState = null;

    const ts = makeTimestamp();
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

ipcMain.handle('validate-phones-manual', async (_event, phones) => {
  if (getConnectedClients().length === 0) return { ok: false, error: 'Nenhuma conta WhatsApp conectada.' };
  const results = [];
  for (const phone of phones) {
    const normalized = normalizePhone(phone);
    if (!normalized) {
      results.push({ input: phone, normalized: '', hasWa: null, error: 'Formato inválido' });
      continue;
    }
    try {
      const result = await getNumberIdWithRetry(normalized);
      const exists = !!result;
      const checkedAt = nowBRT();
      phoneCache[normalized] = { hasWa: exists, checkedAt };
      await savePhone(normalized, exists, checkedAt);
      results.push({ input: phone, normalized, hasWa: exists, checkedAt });
    } catch (err) {
      results.push({ input: phone, normalized, hasWa: null, error: (err.message || String(err)).replace(/[\r\n]+/g, ' ') });
    }
  }
  return { ok: true, results };
});

ipcMain.handle('get-file-info', (_event, filePaths) => {
  try {
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    return paths
      .filter(fp => fs.existsSync(fp))
      .map(fp => ({
        filePath: fp,
        count: fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter(Boolean).length
      }));
  } catch { return []; }
});

ipcMain.handle('revalidate-phone', async (_event, phone) => {
  try {
    const result = await getNumberIdWithRetry(phone);
    const exists = !!result;
    const checkedAt = nowBRT();
    phoneCache[phone] = { hasWa: exists, checkedAt };
    await savePhone(phone, exists, checkedAt);
    return { ok: true, phone, hasWa: exists, checkedAt };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

app.whenReady().then(createWindow);

let isQuitting = false;
app.on('before-quit', async (e) => {
  if (!isQuitting) {
    const connected = getConnectedClients();
    if (connected.length > 0) {
      e.preventDefault();
      isQuitting = true;
      for (const [, acc] of accounts) {
        try { if (acc.client) await acc.client.destroy(); } catch {}
      }
      app.quit();
    }
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });