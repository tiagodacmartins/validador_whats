// ============================================================
//  preload-banco.js — Bridge segura para a janela "Banco de Telefones"
//
//  Expõe `window.banco` ao renderer via contextBridge,
//  fornecendo somente os métodos necessários para consulta e
//  revalidação de números no banco de dados.
// ============================================================

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('banco', {
  /** Conecta ao banco com as credenciais fornecidas. */
  connectDb: (config) =>
    ipcRenderer.invoke('connect-db', config),

  /** Desconecta do banco e libera o pool. */
  disconnectDb: () =>
    ipcRenderer.invoke('disconnect-db'),

  /** Retorna se o banco está conectado. */
  getDbStatus: () =>
    ipcRenderer.invoke('get-db-status'),

  /** Registra callback para receber atualizações do status do banco. */
  onDbStatus: (callback) =>
    ipcRenderer.on('db-status', (_e, data) => callback(data)),

  /** Retorna o total de registros armazenados no banco. */
  getCacheInfo: () =>
    ipcRenderer.invoke('get-cache-info'),

  /**
   * Pesquisa paginada no banco.
   * @param {string} query     Número a buscar (apenas dígitos).
   * @param {string} filter    'all' | 'true' | 'false'
   * @param {number} offset    Offset para paginação.
   * @param {number} pageSize  Registros por página.
   */
  searchCache: (query, filter, offset, pageSize, dateFrom = null, dateTo = null) =>
    ipcRenderer.invoke('search-cache', query, filter, offset, pageSize, dateFrom, dateTo),

  /**
   * Reconsulta um número no WhatsApp e atualiza o registro no banco.
   * @param {string} phone  Número normalizado (ex: "5511999990000").
   */
  revalidatePhone: (phone) =>
    ipcRenderer.invoke('revalidate-phone', phone),

  // ── Controles da janela ──────────────────────────────────────
  windowMinimize: () => ipcRenderer.send('win-minimize'),
  windowMaximize: () => ipcRenderer.send('win-maximize'),
  windowClose:    () => ipcRenderer.send('win-close')
});
