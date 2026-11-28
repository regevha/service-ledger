// A convenience warning, not a security check: domains are still validated by the API.
export const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'walla.co.il', 'walla.com']);
export function senderValueError(kind: 'address' | 'domain', raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(kind === 'domain' ? /^@/ : /$^/, '');
  if (!value) return kind === 'address' ? 'Type the email address.' : 'Type the domain, for example example.org.';
  if (value.length > (kind === 'address' ? 254 : 253)) return kind === 'address' ? 'This address is too long. Check it is one address.' : 'This domain is too long.';
  const domain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  if (kind === 'domain') {
    if (value.includes('@')) return 'Type only the part after the @, for example example.org. To add one address, choose One address.';
    return domain.test(value) ? null : 'This does not look like a domain. Use letters, numbers, dots and hyphens, for example example.org.';
  }
  const parts = value.split('@');
  return parts.length === 2 && parts[0].length <= 64 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(parts[0]) && domain.test(parts[1])
    ? null : 'This does not look like an email address. Check it has one @ and a domain, for example lab-team@example.org.';
}
export function senderLabelError(raw: string): string | null {
  const label = raw.trim();
  if (!label) return 'Type a team or role, for example Flow core team.';
  if (label.length > 60) return 'Keep the team or role to 60 characters or fewer.';
  if (label.includes('@')) return 'A team or role cannot contain @. Use a name such as Flow core team, not an address.';
  if ([...label].some((char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159))) return 'Use a team or role without control characters.';
  return null;
}
