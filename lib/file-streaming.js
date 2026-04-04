'use strict';

const fs = require('fs');
const readline = require('readline');

function createLineReader(filePath) {
  return readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
}

async function countNonEmptyLines(filePath) {
  let count = 0;
  const reader = createLineReader(filePath);

  try {
    for await (const line of reader) {
      if (line.trim()) count++;
    }
  } finally {
    reader.close();
  }

  return count;
}

async function readFirstNonEmptyLine(filePath) {
  const reader = createLineReader(filePath);

  try {
    for await (const line of reader) {
      const trimmedLine = line.trim();
      if (trimmedLine) return trimmedLine;
    }
  } finally {
    reader.close();
  }

  return '';
}

async function* streamNonEmptyLines(filePath, startIndex = 0) {
  const reader = createLineReader(filePath);
  let index = 0;

  try {
    for await (const line of reader) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      if (index < startIndex) {
        index++;
        continue;
      }
      yield { index, line: trimmedLine };
      index++;
    }
  } finally {
    reader.close();
  }
}

module.exports = {
  countNonEmptyLines,
  readFirstNonEmptyLine,
  streamNonEmptyLines
};