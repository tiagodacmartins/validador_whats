# Desenvolvimento — Validador WhatsApp GUI

Guia para desenvolvedores querendo contribuir ou entender a arquitetura.

---

## 🏗️ Arquitetura em Profundidade

### 3 Processos Electron

```
┌─────────────────────────────────────────────────────┐
│           USER INTERACTS                            │
│  (Clica botão, digita, arrasta arquivo)             │
└────────────────────┬────────────────────────────────┘
                     ▼
         ┌───────────────────────┐
         │   RENDERER PROCESS    │
         │  (HTML + Browser JS)  │
         │                       │
         │ ● whatsapp-validator- │
         │   gui.html            │
         │ ● banco-telefones.html│
         │ ● whatsapp-connect.   │
         │   html                │
         └────────┬──────────────┘
                  │
         ╔════════╩═════════╗
         ║  IPC BRIDGE      ║
         ║  contextBridge   ║
         ║  (preload.js)    ║
         ╚════════╦═════════╝
                  │
         ┌────────▼──────────────┐
         │     MAIN PROCESS      │
         │  (Node.js Backend)    │
         │                       │
         │ ● main.js            │
         │  ├─ Janelas          │
         │  ├─ IPC Handlers     │
         │  ├─ WhatsApp Clients │
         │  └─ DB Pool          │
         └────────┬──────────────┘
                  │
         ┌────────┴──────────┬──────────────┐
         ▼                   ▼              ▼
     ┌─────────┐      ┌──────────┐    ┌─────────┐
     │ WhatsApp│      │PostgreSQL│    │Filesystem
     │Web.js   │      │ Supabase │    │(output/)
     │         │      │          │    │
     │         │      │          │    │
     └─────────┘      └──────────┘    └─────────┘
```

### Fluxo de Dados: Exemplo Inicial de Validação

```
1. RENDERER (UI)
   └─ User clica "Iniciar validação"
      └─ waApp.startValidation({ inputPaths, config })

2. IPC INVOKE
   └─ preload.js
      └─ ipcRenderer.invoke('start-validation', { inputPaths, config })

3. MAIN PROCESS
   └─ ipcMain.handle('start-validation', async (event, { inputPaths, config }) => {
        // Implementa:
        // ● Lê arquivos
        // ● Nomarliza telefones
        // ● Loop paralelo (runWorker por conta)
        // ● Query WhatsApp (getNumberId)
        // ● Cache em DB
        // ● Escreve output

4. PROGRESS EVENT (BROADCAST)
   └─ mainWindow.webContents.send('progress', { row, current, total, status })
      └─ RENDERER recebe
         └─ Atualiza tabela + contadores em tempo real

5. RETURN ao Renderer
   └─ Resultado final: { ok: true, valid: 234, invalid: 45, zipOut: '...' }
```

---

## 📁 Estrutura de Arquivos

```
validador_whats/
├── main.js                          ← Processo principal (1100+ linhas)
│   ├─ createWindow() / createBancoWindow() / createConnectWindow()
│   ├─ WhatsApp client management (Map<id, account>)
│   ├─ start-validation handler
│   ├─ getNumberIdWithRetry() — retry logic + delays
│   └─ DB pool management
│
├── preload.js                       ← Bridge principal (exposição IPC)
│   └─ contextBridge.exposeInMainWorld('waApp', {...})
│      ├─ pickFile(), validatePhonesManual(), startValidation(), etc.
│      └─ onProgress(), onStatus(), onAccounts() — listeners
│
├── preload-banco.js                 ← Bridge banco (DB operations)
│   └─ contextBridge.exposeInMainWorld('banco', {...})
│      ├─ connectDb(), disconnectDb(), searchCache()
│      └─ onDbStatus()
│
├── preload-connect.js               ← Bridge conexão (WhatsApp)
│   └─ contextBridge.exposeInMainWorld('waConnect', {...})
│      ├─ addAccount(), disconnectWhatsApp(), removeAccount()
│      └─ getAccounts(), openWhatsAppWeb()
│
├── whatsapp-validator-gui.html      ← UI Principal (1800+ linhas)
│   ├─ <div class="grid"> — 3 colunas
│   │  ├─ Esquerda: Configuração + inputs
│   │  ├─ Meio: Progresso + estatísticas
│   │  └─ Direita: Log do validador
│   ├─ <div class="titlebar"> — Win98 titlebar
│   └─ Abas: Validador | Banco | WhatsApp
│
├── banco-telefones.html             ← UI para cache DB
│   ├─ Formulário de conexão
│   ├─ Busca + filtros
│   └─ Tabela paginada de resultados
│
├── whatsapp-connect.html            ← UI para QR code
│   └─ <div id="qrContainer">
│
├── package.json                     ← Dependências + scripts
│   ├─ dependencies: whatsapp-web.js, pg, archiver, qrcode
│   └─ devDependencies: electron, electron-builder, electron-packager, jimp
│
├── build/
│   ├─ gen-icon.js                   ← Gerador de ícone Win98
│   ├─ icon.ico                      ← Ícone compilado
│   └─ make-dist.js                  ← Gerador de ZIP
│
├── .github/
│   └─ workflows/
│       └─ release.yml               ← GitHub Action (tag → zip)
│
├── README.md                        ← Documentação de usuário
├── SECURITY.md                      ← Políticas de segurança
├── DEVELOPMENT.md                   ← Este arquivo
└── .gitignore
    ├─ db-config.json                (❌ NUNCA commit)
    ├─ credentials.json              (❌ NUNCA commit)
    ├─ node_modules/
    ├─ dist/
    ├─ output/
    └─ .wwebjs_*
```

---

## 🔄 Fluxos Principais

### Validação em Lote (start-validation)

```
User clica "Iniciar validação"
│
├─ Carrega arquivo(s)
│  └─ Normaliza telefones (E.164)
│
├─ Loop paralelo por conta conectada
│  └─ Cada conta: runWorker(client)
│     └─ while (!cancelRequested && nextIdx < total)
│        ├─ Pega próxima linha (nextIdx++)
│        ├─ QuerygetttNumberIdWithRetry(phone, client)
│        ├─ Aplica delay aleatório
│        ├─ Se batchCount >= batchSize → sleep(batchPauseMs)
│        ├─ Salva resultado em array (ordenado)
│        └─ ipcMain send 'progress'
│
├─ Nach término, salva arquivos
│  ├─ output/validados_parcial_<timestamp>/
│  │  ├─ *.txt — apenas linhas válidas (sem header)
│  │  └─ *.csv — relatório completo
│  └─ Cria ZIP
│
└─ Retorna ao Renderer: { ok: true, valid: X, invalid: Y, zipOut: '...' }
```

### Conexão WhatsApp (addAccount)

```
User clica "Adicionar conta"
│
├─ Abre connectWindow com QR container
│
├─ Main process cria novo Client
│  ├─ new Client({ authStrategy: LocalAuth })
│  └─ client.on('qr', async (qr) => {
│     └─ Gera DataURL e envia ao connectWindow
│  })
│
├─ connectWindow exibe QR
│  └─ User escaneia com celular
│
├─ WhatsApp autentica
│  ├─ client.on('authenticated', () => { isReady = true })
│  └─ client.on('ready', () => { ipcMain.send('accounts', ...) })
│
└─ mainWindow atualiza lista de contas
```

---

## 🎯 Pontos de Extensibilidade

### 1. **Adicionar novo tipo de consulta**

Se quiser validar algo além de WhatsApp:

```js
// main.js — Adicione handler
ipcMain.handle('validate-sms', async (_event, phone) => {
  // Sua lógica de SMS validation
  return { ok: true, hasSMS: true };
});

// preload.js — Exponha no bridge
contextBridge.exposeInMainWorld('waApp', {
  // ...
  validateSms: (phone) => ipcRenderer.invoke('validate-sms', phone),
});

// HTML — Use no renderer
const result = await waApp.validateSms('5511999990000');
```

### 2. **Mudar fonte de cache**

Atualmente: PostgreSQL. Quer usar SQLite ou Redis?

```js
// main.js:850+ — Substitua pool.query por:
if (config.cache === 'sqlite') {
  const db = new Database('cache.db');
  const row = db.prepare('SELECT ... WHERE phone = ?').get(phone);
} else if (config.cache === 'redis') {
  const val = await redis.get(`phone:${phone}`);
}
```

### 3. **Adicionar nova aba UI**

Quer adicionar aba para configurações avançadas?

```js
// whatsapp-validator-gui.html
// 1. Adicione <button class="tab" data-tab="settings">⚙️ Configs</button>
// 2. Adicione <div id="tab-settings" class="tab-panel">...</div>
// 3. Adicione listener em JavaScript:
document.querySelectorAll('.tab').forEach(t => 
  t.addEventListener('click', () => switchTab(t.dataset.tab))
);
```

---

## 🧪 Testes Manuais

### Teste: Múltiplas contas em paralelo

```bash
1. npm start
2. Conecte 3 contas WhatsApp
3. Selecione arquivo com 500 linhas
4. Clique "Iniciar validação"
5. Observe Log — deve processar ~3 linhas em paralelo
   ✓ Aceleração esperada: ~2x-3x comparado a 1 conta
```

### Teste: Pausa & Retoma

```bash
1. Comece validação gran 1000 linhas
2. Após ~200 processadas, clique "Pausar"
   ✓ Esperado: "↺ Retomar" aparece
3. Clique "↺ Retomar"
   ✓ Esperado: Continua de ~200, não desde o início
4. Verifique ZIP baixado contém ~200 resultados
```

### Teste: BD Cache

```bash
1. Conecte Supabase
2. Valide 100 números (acessa DB)
3. Repita com os mesmos 100 números
   ✓ Esperado: Segunda vez é ~10x mais rápida (cache)
4. Verifique em "Banco de Telefones" — todos aparecem lá
```

---

## 🐛 Debugging

### Enable DevTools

```js
// main.js, dentro de createWindow()
mainWindow.webContents.openDevTools();
```

### Log no console do Main

```js
// main.js
console.log('[validador]', 'Msg aqui');  // Aparece no stdout do terminal
```

### Log no browser Console

```js
// whatsapp-validator-gui.html
console.log('Msg no renderer');  // Aparece no DevTools → Console
```

### Comum: `ipcRenderer is not defined`

**Causa**: contextBridge falhou. Verifique:
```js
// preload.js — Deve haver:
contextBridge.exposeInMainWorld('waApp', { ... });

// HTML — Deve chamar:
// window.waApp.pickFile()  ← Não ipcRenderer!
```

---

## 📊 Code Quality Observations

### Anti-patterns a evitar

✗ **DON'T**: `await Promise.all()` sem limite
```js
// Perigoso:
await Promise.all(bigArray.map(async () => {
  // Cria Promise para cada item → memory leak com 100K items
}));
```

✓ **DO**: Implementar semaphore
```js
const MAX_CONCURRENT = 10;
const sem = new Semaphore(MAX_CONCURRENT);
await Promise.all(bigArray.map(item => sem.acquire(async () => { ... })));
```

✗ **DON'T**: `.catch {}` silencioso
```js
fsPromises.writeFile(path, data).catch {}; // ← Oculta erro!
```

✓ **DO**: Log e trate
```js
fsPromises.writeFile(path, data).catch(err => {
  console.warn('[file] Write failed:', err.message);
  // Fallback ou retry
});
```

---

## 🚀 Roadmap Técnico

### v1.2.0 (Próximo)
- [ ] Path traversal validation (SECURITY)
- [ ] Logging ao invés de `.catch {}`
- [ ] Rate limiting em IPC

### v2.0.0 (Medium-term)
- [ ] Streaming file reader (memory fix)
- [ ] Exponential backoff retry
- [ ] Load-aware scheduling
- [ ] Unit tests (Jest)
- [ ] E2E tests (Playwright)

### v3.0.0 (Long-term)
- [ ] Multi-platform (Linux, macOS)
- [ ] Web app companion (status remoto)
- [ ] Plugin system para exporters

---

## 📞 Contribuindo

1. Fork o repositório
2. Crie branch: `git checkout -b feat/sua-feature`
3. Commit com conventional commits: `git commit -m "feat: descrição"`
4. Push: `git push origin feat/sua-feature`
5. Abra Pull Request

**Checklist before PR**:
- [ ] Roda sem erros (`npm start`)
- [ ] Sem console warnings/errors
- [ ] Testes manuais passam
- [ ] Nenhum arquivo sensível commitado

---

**Última atualização**: 2026-04-04

