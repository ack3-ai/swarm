/** The one text order for keys and lists that feed a digest or a stored record (C1).
 * Plain `localeCompare` follows the machine's locale (Czech sorts `ch` after `h`);
 * English is the Workers default, so this keeps every existing order and digest.
 * Same order as `new Intl.Collator('en').compare`; this form keeps V8's fast path
 * (about twice as fast when sorting keys, which the canonical writer does per object). */
export function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}
