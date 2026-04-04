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
  searchCache: (query, filter, offset, pageSize) =>
    ipcRenderer.invoke('search-cache', query, filter, offset, pageSize),

  /**
   * Reconsulta um número no WhatsApp e atualiza o registro no banco.
   * @param {string} phone  Número normalizado (ex: "5511999990000").
   */
  revalidatePhone: (phone) =>
    ipcRenderer.invoke('revalidate-phone', phone)
});
