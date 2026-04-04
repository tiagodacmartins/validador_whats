// ============================================================
//  preload-connect.js — Bridge segura para a janela de conexão WhatsApp
//
//  Expõe `window.waConnect` ao renderer da janela "whatsapp-connect.html",
//  fornecendo somente os métodos necessários para gerenciar a conexão.
// ============================================================

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('waConnect', {
  /** Conecta (ou reconecta) a primeira conta WhatsApp disponível. */
  connectWhatsApp:    () => ipcRenderer.invoke('connect-whatsapp'),
  /** Desconecta a primeira conta WhatsApp ativa. */
  disconnectWhatsApp: () => ipcRenderer.invoke('disconnect-whatsapp'),
  /** Retorna informações da conta conectada (nome, número, plataforma). */
  getWaInfo:          () => ipcRenderer.invoke('get-wa-info'),
  /** Registra callback para receber atualizações de status do WhatsApp. */
  onStatus: (callback) => ipcRenderer.on('wa-status', (_e, data) => callback(data)),
  /** Controles da janela. */
  windowMinimize: () => ipcRenderer.send('win-minimize'),
  windowMaximize: () => ipcRenderer.send('win-maximize'),
  windowClose:    () => ipcRenderer.send('win-close')
});
