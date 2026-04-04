'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { countNonEmptyLines, readFirstNonEmptyLine, streamNonEmptyLines } = require('../lib/file-streaming');

describe('file-streaming', () => {
  let tempDir;
  let tempFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validador-whats-'));
    tempFile = path.join(tempDir, 'entrada.txt');
    fs.writeFileSync(tempFile, '\n  \n5511999999999;Alice\n\n5511888888888;Bob\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('countNonEmptyLines conta apenas linhas com conteudo', async () => {
    await expect(countNonEmptyLines(tempFile)).resolves.toBe(2);
  });

  test('readFirstNonEmptyLine retorna a primeira linha util', async () => {
    await expect(readFirstNonEmptyLine(tempFile)).resolves.toBe('5511999999999;Alice');
  });

  test('streamNonEmptyLines respeita skip inicial e indices logicos', async () => {
    const rows = [];
    for await (const entry of streamNonEmptyLines(tempFile, 1)) {
      rows.push(entry);
    }

    expect(rows).toEqual([
      { index: 1, line: '5511888888888;Bob' }
    ]);
  });
});