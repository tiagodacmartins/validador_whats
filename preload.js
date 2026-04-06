// ============================================================
//  preload.js — Bridge segura para a janela principal
//
//  Expõe `window.waApp` ao renderer via contextBridge,
//  sem conceder acesso direto ao Node.js/Electron.
//  Cada método invoca um canal IPC correspondente no main.js.
// ============================================================

'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('waApp', {

  // ── Seleção de arquivos ──────────────────────────────────────
  /** Abre o diálogo para selecionar um ou mais arquivos TXT. */
  pickFile: () => ipcRenderer.invoke('pick-file'),
  /** Abre o diálogo para selecionar a pasta de saída. */
  pickOutputFolder: () => ipcRenderer.invoke('pick-output-folder'),

  // ── Leitura de arquivo ───────────────────────────────────────
  /** Retorna a contagem de linhas de um ou mais arquivos. */
  getFileInfo: (filePaths) => ipcRenderer.invoke('get-file-info', filePaths),
  /** Lê a primeira linha de um arquivo e retorna as colunas detectadas (separadas por `;`). */
  getFileColumns: (filePath) => ipcRenderer.invoke('get-file-columns', filePath),
  /** Resolve caminhos absolutos de arquivos arrastados para a drop zone. */
  getDroppedFilePaths: (files) => {
    const list = Array.isArray(files) ? files : Array.from(files || []);
    return list.map(file => {
      try {
        return webUtils.getPathForFile(file) || '';
      } catch {
        return file?.path || '';
      }
    }).filter(Boolean);
  },

  // ── Validação em lote ────────────────────────────────────────
  /** Inicia a validação conforme o payload de configuração. */
  startValidation: (payload) => ipcRenderer.invoke('start-validation', payload),
  /** Solicita o cancelamento da validação em andamento (Parar ou Pausar). */
  cancelValidation: () => ipcRenderer.invoke('cancel-validation'),

  // ── Validação manual (campo "Validação rápida") ──────────────
  /** Valida uma lista de números avulsos e retorna o resultado de cada um. */
  validatePhonesManual: (phones) => ipcRenderer.invoke('validate-phones-manual', phones),

  // ── Banco de dados (phone_cache) ─────────────────────────────
  /** Conecta ao banco com as credenciais fornecidas. */
  connectDb: (config) => ipcRenderer.invoke('connect-db', config),
  /** Desconecta do banco e libera o pool. */
  disconnectDb: () => ipcRenderer.invoke('disconnect-db'),
  /** Retorna se o banco está conectado. */
  getDbStatus: () => ipcRenderer.invoke('get-db-status'),
  /** Retorna o total de registros no banco. */
  getCacheInfo: () => ipcRenderer.invoke('get-cache-info'),
  /** Pesquisa paginada no banco com filtro de número e status. */
  searchCache: (query, filter, offset = 0, pageSize = 500, dateFrom = null, dateTo = null) =>
    ipcRenderer.invoke('search-cache', query, filter, offset, pageSize, dateFrom, dateTo),
  /** Reconsulta um número no WhatsApp e atualiza o banco. */
  revalidatePhone: (phone) => ipcRenderer.invoke('revalidate-phone', phone),

  // ── Contas WhatsApp ──────────────────────────────────────────
  /** Retorna a lista de todas as contas e seus estados. */
  getAccounts: () => ipcRenderer.invoke('get-accounts'),
  /** Adiciona e inicializa uma nova conta WhatsApp. */
  addAccount: () => ipcRenderer.invoke('add-account'),
  /** Remove uma conta e destrói sua sessão salva. */
  removeAccount: (id) => ipcRenderer.invoke('remove-account', id),
  /** Conecta (ou reconecta) uma conta pelo ID. */
  connectWhatsApp: (id) => ipcRenderer.invoke('connect-whatsapp', id),
  /** Desconecta uma conta sem removê-la. */
  disconnectWhatsApp: (id) => ipcRenderer.invoke('disconnect-whatsapp', id),
  /** Retorna informações da conta conectada (nome, número, plataforma). */
  getWaInfo: (id) => ipcRenderer.invoke('get-wa-info', id),
  /** Retorna o QR Code pendente (compatibilidade legada). */
  getQr: () => ipcRenderer.invoke('get-qr'),
  /** Abre o WhatsApp Web no Microsoft Edge. */
  openWhatsAppWeb: () => ipcRenderer.invoke('open-whatsapp-web'),

  // ── Janelas e sistema ────────────────────────────────────────
  /** Abre a janela de gerenciamento de conexão WhatsApp. */
  openConnectWindow: () => ipcRenderer.invoke('open-connect-window'),
  /** Abre a janela do Banco de Telefones. */
  openBancoWindow: () => ipcRenderer.invoke('open-banco-window'),
  /** Abre o Explorer na pasta do arquivo indicado. */
  openPath: (p) => ipcRenderer.invoke('open-path', p),

  // ── Controles da janela ────────────────────────────────────────
  /** Minimiza a janela principal. */
  windowMinimize: () => ipcRenderer.send('win-minimize'),
  /** Alterna entre maximizado e restaurado. */
  windowMaximize: () => ipcRenderer.send('win-maximize'),
  /** Fecha a janela. */
  windowClose:    () => ipcRenderer.send('win-close'),  /** Retorna a versão do app definida no package.json. */
  getAppVersion:  () => ipcRenderer.invoke('get-app-version'),
  // ── Eventos (push do main → renderer) ───────────────────────
  /** Registra callback para receber atualizações de status do WhatsApp. */
  onStatus:   (callback) => ipcRenderer.on('wa-status',            (_e, data) => callback(data)),
  /** Registra callback para receber atualizações das contas. */
  onAccounts: (callback) => ipcRenderer.on('wa-accounts',          (_e, data) => callback(data)),
  /** Registra callback para receber progresso da validação em lote. */
  onProgress: (callback) => ipcRenderer.on('validation-progress',  (_e, data) => callback(data)),
  /** Registra callback para receber atualizações do status do banco. */
  onDbStatus: (callback) => ipcRenderer.on('db-status', (_e, data) => callback(data)),

  // ── Dashboard ────────────────────────────────────────────────
  /** Retorna estatísticas por conta e totais diários do banco. */
  getDashboardStats: (dateFrom, dateTo) => ipcRenderer.invoke('get-dashboard-stats', dateFrom, dateTo),
});
