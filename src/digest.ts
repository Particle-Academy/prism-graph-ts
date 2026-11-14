import { createHash } from 'node:crypto';

/**
 * sha256 of a length-prefixed tuple, byte-identical to the PHP reference's
 * Support\Digest::of(). Lengths are UTF-8 BYTE lengths, as PHP's strlen().
 * A separator byte would let two different tuples hash the same; a length
 * prefix cannot be forged that way.
 */
export function digest(domain: string, fields: ReadonlyArray<string | number | Uint8Array>): string {
  const hash = createHash('sha256');
  const part = (field: string | number | Uint8Array): void => {
    const bytes = typeof field === 'string' ? Buffer.from(field, 'utf8')
      : typeof field === 'number' ? Buffer.from(String(field), 'utf8')
      : Buffer.from(field);
    hash.update(`${bytes.length}:`);
    hash.update(bytes);
  };
  part(domain);
  for (const field of fields) {
    part(field);
  }

  return hash.digest('hex');
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
