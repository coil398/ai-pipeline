/** @param {string} text @param {string|undefined} [field] @returns {string} */
export function extractVerdict(text, field = undefined) {
  if (field) { try { const parsed = JSON.parse(text); const value = field.split('.').reduce((current, key) => current?.[key], parsed); return value == null ? '' : String(value); } catch { return ''; } }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^## VERDICT\s*$/i.test(lines[i])) { const next = lines.slice(i + 1).find(line => line.trim()); if (next) return next.trim(); }
    const match = lines[i].match(/^VERDICT:\s*(\S.*)$/i); if (match) return match[1].trim();
  }
  return '';
}
/** @param {{cases: Array<{when: string[], goto: string}>, field?: string}} step @param {string} text @returns {{when: string[], goto: string}|null} */
export function chooseCase(step, text) {
  const verdict = extractVerdict(text, step.field);
  return step.cases.find(item => item.when.includes(verdict)) ?? null;
}
