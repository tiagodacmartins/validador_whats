# Validador WhatsApp

Aplicativo desktop para validar numeros de telefone no WhatsApp em lote.

## O que o validador faz

- Valida listas de telefones e informa se cada numero tem ou nao WhatsApp.
- Suporta multiplas contas WhatsApp em paralelo para distribuir as consultas.
- Gera relatorios em TXT e CSV ao final da execucao.
- Permite pausar e retomar validacoes.
- Opcionalmente usa banco PostgreSQL (ex: Supabase) como cache para evitar consultas repetidas.

## Requisitos

- Windows 10 ou 11
- Node.js 18+
- Microsoft Edge instalado
- Pelo menos 1 conta WhatsApp ativa para leitura de QR Code

## Como rodar

## Opcao 1: Download do zip x64

Baixe através desse link: https://github.com/tiagodacmartins/validador_whats/releases ou
do lado direito em "Releases"

### Opcao 2: Clonando o repositorio

1. Clone o projeto:

```bash
git clone https://github.com/tiagodacmartins/validador_whats.git
cd validador_whats
```

2. Instale as dependencias:

```bash
npm install
```

3. Rode o app:

```bash
npm start
```

### Opcao 3: Baixando o ZIP do repositorio

1. No GitHub, clique em Code > Download ZIP.
2. Extraia o ZIP para uma pasta local.
3. Abra terminal dentro da pasta extraida.
4. Execute:

```bash
npm install
npm start
```

## Primeiro uso (resumo)

1. Abra a aba WhatsApp e adicione uma conta.
2. Escaneie o QR Code com o celular.
3. Selecione 1 ou mais arquivos TXT com os numeros.
4. Ajuste delays/lotes se necessario.
5. Clique em Iniciar validacao.

## Formato de entrada

Arquivos TXT com uma linha por registro.

Exemplos:

```text
5511999990000
5511999990000;Nome Cliente;Empresa X
```

O telefone pode estar sem o 55 (o app tenta normalizar automaticamente).

## Saida gerada

- TXT: numeros com WhatsApp
- CSV: relatorio completo da execucao
- ZIP: pacote final com os arquivos de saida

## Banco de dados (opcional)

Se voce conectar um PostgreSQL, o app salva resultados em cache na tabela phone_cache.
Assim, numeros ja consultados podem ser reaproveitados em proximas execucoes.

Tabela minima esperada:

```sql
CREATE TABLE phone_cache (
  phone      TEXT PRIMARY KEY,
  has_wa     BOOLEAN NOT NULL,
  checked_at TIMESTAMP NOT NULL
);
```

## Scripts uteis

```bash
npm start      # roda o app em modo desenvolvimento
npm test       # executa testes unitarios
npm run dist   # gera pacote zip distribuivel
```

Saida do build:

dist/Validador-WhatsApp-win-x64.zip

## Observacoes

- Nao commitar arquivos com credenciais locais.
- Se o banco estiver desconectado, o app continua funcionando sem cache.
- Se nenhuma conta WhatsApp estiver conectada, a validacao normal nao inicia.

## Licenca

MIT
Tiago da Conceição Martins
