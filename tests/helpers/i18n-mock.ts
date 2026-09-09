import { vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function parseSimpleYaml(yamlStr: string): Record<string, any> {
  const lines = yamlStr.split('\n');
  const root: Record<string, any> = {};
  const stack: { indent: number; obj: Record<string, any> }[] = [{ indent: -1, obj: root }];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.search(/\S/);
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(indent, colonIdx).trim();
    let valStr = line.slice(colonIdx + 1).trim();

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const currentObj = stack[stack.length - 1].obj;

    if (!valStr) {
      const newObj: Record<string, any> = {};
      currentObj[key] = newObj;
      stack.push({ indent, obj: newObj });
    } else {
      if ((valStr.startsWith('"') && valStr.endsWith('"')) || (valStr.startsWith("'") && valStr.endsWith("'"))) {
        valStr = valStr.slice(1, -1);
      }
      currentObj[key] = valStr;
    }
  }
  return root;
}

export function loadDefaultKoreanMessages(): Record<string, any> {
  try {
    const possiblePaths = [
      resolve(process.cwd(), 'src/locales/ko.yml'),
      resolve(process.cwd(), 'locales/ko.yml'),
      resolve(__dirname, '../../src/locales/ko.yml'),
      resolve(__dirname, '../../src/locales/ko.yml')
    ];
    for (const p of possiblePaths) {
      if (existsSync(p)) {
        return parseSimpleYaml(readFileSync(p, 'utf-8'));
      }
    }
  } catch (e) {
    // fallback
  }
  return {};
}

export function createI18nMock(messages?: Record<string, any>) {
  const dictionary = messages ?? loadDefaultKoreanMessages();

  return {
    t: vi.fn((key: string, substitutions?: Record<string, any> | any[]) => {
      let msg = getNestedValue(dictionary, key) ?? key;
      if (substitutions) {
        if (Array.isArray(substitutions)) {
          substitutions.forEach((sub, i) => {
            msg = msg.replace(new RegExp(`\\$${i + 1}`, 'g'), String(sub));
          });
        } else if (typeof substitutions === 'object') {
          Object.entries(substitutions).forEach(([k, v]) => {
            msg = msg.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
          });
        }
      }
      return msg;
    })
  };
}

function getNestedValue(obj: Record<string, any>, path: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = path.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return typeof current === 'string' ? current : undefined;
}
