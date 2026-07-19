/** A named icon glyph. */
export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <i data-icon={name} style={{ fontSize: size }} />;
}
