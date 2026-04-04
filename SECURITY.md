# Segurança — Validador WhatsApp GUI

## 🔒 Postura de Segurança

Este projeto foi analisado com segurança em mente. Abaixo estão os pontos críticos, medidas implementadas e recomendações.

---

## ✅ Medidas de Segurança Implementadas

### 1. **Context Isolation** (Electron)
- `contextIsolation: true` em todos os 3 BrowserWindows
- Renderer **isolado** do Node.js
- `nodeIntegration: false` forçado

### 2. **Preload Bridge (contextBridge)**
```js
contextBridge.exposeInMainWorld('waApp', {
  pickFile: () => ipcRenderer.invoke('pick-file'),
  startValidation: (config) => ipcRenderer.invoke('start-validation', config),
  // ... apenas funções necessárias expostas
});
```
✅ **Resultado**: Renderer não acessa `fs`, `child_process`, ou outros módulos perigosos.

### 3. **SQL Injection Prevention**
Todas as queries usam **parameterized queries**:
```js
const { rows } = await pool.query(
  'SELECT * FROM phone_cache WHERE phone = $1 AND has_wa = $2',
  [phone, true]  // ← Parâmetros seguros
);
```
✅ **Resultado**: Impossível injetar SQL.

### 4. **XSS Prevention**
Todo texto inserido via `.innerHTML` passa por `escapeHtml()`:
```js
function escapeHtml(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
```
✅ **Resultado**: Nenhuma injeção XSS é possível.

### 5. **Credenciais Não Logadas**
- Passwords **nunca** aparecem em console.log
- `.gitignore` protege `db-config.json` e `credentials.json`

---

## 🔴 Achados Críticos

### 1. **db-config.json em Plaintext no Repositório**

**Status**: ⚠️ **MITIGADO** para versão atual\
**Risco**: Vazamento de credenciais Supabase

**Contexto**:
- Arquivo foi historicamente commitado
- Removido via `git-filter-repo` do histórico antes de tornar público
- Localmente, nunca é commitado (`.gitignore`)

**Ação Recomendada**:
1. Se código foi publicado antes, **regenerar senhã Supabase** imediatamente
2. Usar enviroment variables para credenciais, nunca arquivos plaintext em produção

**Futuro**:
```bash
# Ao usar em servidor, configure:
export DB_HOST=...
export DB_USER=...
export DB_PASSWORD=...
```

---

### 2. **Path Traversal em File Operations**

**Status**: ⚠️ **IDENTIFICADO**, correção planejada

**Localização**: 
- `pick-file`, `get-file-info`, `get-file-columns` handlers

**Risco**: Atacante injeta `../../etc/passwd` via IPC

**Exemplo vulnerável**:
```js
ipcMain.handle('get-file-info', (_event, filePaths) => {
  return filePaths
    .filter(fp => fs.existsSync(fp))  // ← Sem validação!
    .map(fp => ({...}));
});
```

**Mitigação Imediata**:
```js
function isSafeFilePath(userPath) {
  const resolved = path.resolve(userPath);
  const root = path.resolve(process.cwd());
  return resolved.startsWith(root) && !resolved.includes('..');
}
```

---

### 3. **Promise Concurrency Sem Limite**

**Status**: ⚠️ **IDENTIFICADO**, correção planejada

**Risco**: Memory leak / DoS em validação com muitas contas

**Cenário**:
- 5 contas + 100K linhas → até 500K promises simultâneos
- WhatsApp Web.js / Puppeteer sockets esgotados
- Pool PostgreSQL (max 10) fica aguardando infinitamente

**Mitigação**:
```js
// Implementar semaphore
const MAX_CONCURRENT = Math.min(10, connectedAccts.length * 2);
// Usar fila com limite de promises ativas
```

---

### 4. **TLS com `rejectUnauthorized: false`**

**Status**: ⚠️ **MEDIUM RISK**

**Problema**:
```js
// main.js
ssl: config.ssl ? { rejectUnauthorized: false } : false
```

Disabilita validação de certificado SSL → vulnerável a **MITM**.

**Recomendação**:
```js
// Melhor
ssl: process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: true }  // Prod: strict
  : { rejectUnauthorized: false } // Dev: relaxed
```

---

## ⚠️ Vulnerabilidades Médias

### 5. **Empty Catch Blocks Sem Log**

Múltiplos `.catch {}` silenciam erros, impossibilitando diagnóstico.

**Exemplo**:
```js
try {
  fs.writeFileSync(path, JSON.stringify(data), 'utf8');
} catch {}  // ← Oculta erro de permissão/disco cheio
```

**Impacto**: Silent failures em operações críticas.

**Fix**: Sempre log em `.catch`:
```js
.catch(err => {
  console.error('[component] Error detail:', err.message);
});
```

---

### 6. **Arquivo Inteiro em Memória**

**Problema**:
```js
const rawLines = fs.readFileSync(inputPath, 'utf8').split(/\r?\n/);
```

Arquivo de 1 GB → 1 GB em RAM.

**Impacto**: Out-of-memory em máquinas antigas.

**Fix (v2.0)**:
```js
const readline = require('readline');
const rl = readline.createInterface({
  input: fs.createReadStream(inputPath)
});
for await (const line of rl) {
  // processa linha por linha, O(1) memory
}
```

---

## 🛡️ Recomendações

| # | Issue | Prioridade | Esforço | Status |
|---|-------|-----------|--------|--------|
| 1 | Regenerar Supabase credentials | 🔴 CRÍTICO | 10 min | ⏳ Manual |
| 2 | Path traversal validation | 🔴 CRÍTICO | 1h | ⏳ Planned |
| 3 | Concurrency limit (semaphore) | 🔴 CRÍTICO | 2h | ⏳ Planned |
| 4 | Logging ao invés de `.catch {}` | 🟡 ALTO | 2h | ⏳ Planned |
| 5 | TLS `rejectUnauthorized: true` | 🟡 ALTO | 30 min | ⏳ Planned |
| 6 | Streaming file reader | 🟡 ALTO | 3h | ⏳ v2.0 |

---

## 📋 Checklist para Deploy em Produção

- [ ] ✅ `contextIsolation: true` em todas as janelas (FEITO)
- [ ] ✅ Sem `nodeIntegration` (FEITO)
- [ ] ✅ HTML escaping implementado (FEITO)
- [ ] ⏳ Regenerar credenciais Supabase
- [ ] ⏳ Validar todos os file paths
- [ ] ⏳ Implementar rate limiting em IPC
- [ ] ⏳ Remover `.catch {}` silenciosos
- [ ] ⏳ Ativar `rejectUnauthorized: true` em prod

---

## 📞 Relatar Vulnerabilidades

Se encontrar uma vulnerabilidade:

1. **Não reporte em Issues públicas**
2. Envie email para: (a ser configurado)
3. Inclua:
   - Descrição clara
   - Passos para reproduzir
   - Impacto/severidade
   - Proof of concept (se aplicável)

---

## 🔗 Referências

- [Electron Security Best Practices](https://www.electronjs.org/docs/tutorial/security)
- [OWASP Top 10 2021](https://owasp.org/Top10/)
- [Node.js Security Best Practices](https://nodejs.org/en/knowledge/file-system/security/introduction/)

---

**Última atualizada**: 2026-04-04  
**Próxima revisão**: 2026-07-04 (trimestral)
