/* Serialized JSON stores. Every mutation to one file chains on a per-file promise,
   so concurrent workers and HTTP handlers can't interleave read-modify-write
   cycles. High-frequency streams use append-only JSONL instead of whole-file writes.

   Lesson learned the hard way: anything two writers can touch goes through this,
   no exceptions. An unprotected loadJson/saveJson pair survived weeks of light use,
   then ~70 concurrent writers clobbered each other and most records vanished. */
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

const chains = new Map();
function chain(path, fn) {
  const prev = chains.get(path) || Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(path, next.catch(() => {}));
  return next;
}

export function createStore(path, fallback) {
  return {
    async read() {
      try { return JSON.parse(await readFile(path, "utf8")); }
      catch { return structuredClone(fallback); }
    },
    // fn(value) mutates in place (or returns a value to pass through); the store
    // saves the mutated object. Serialized per file.
    mutate(fn) {
      return chain(path, async () => {
        let val;
        try { val = JSON.parse(await readFile(path, "utf8")); }
        catch { val = structuredClone(fallback); }
        const out = await fn(val);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(val, null, 2));
        return out === undefined ? val : out;
      });
    },
  };
}

export function appendJsonl(path, obj) {
  return chain(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(obj) + "\n");
  });
}

export async function readJsonl(path) {
  try {
    const raw = await readFile(path, "utf8");
    const rows = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip torn line */ }
    }
    return rows;
  } catch { return []; }
}
