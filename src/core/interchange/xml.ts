export function escapeXml(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

export function tagValue(xml: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'i').exec(xml);
  return match ? decodeXml(match[1]!.trim()) : undefined;
}

export interface XmlElement {
  attributes: string;
  inner: string;
}

export function tagElements(xml: string, tag: string): XmlElement[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<${escaped}(\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, 'gi');
  return [...xml.matchAll(regex)].map((match) => ({
    attributes: match[1] ?? '',
    inner: match[2] ?? '',
  }));
}

export function tagBlocks(xml: string, tag: string): string[] {
  return tagElements(xml, tag).map((element) => element.inner);
}

export function attributeValue(tagText: string, attribute: string): string | undefined {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*=\\s*"([^"]*)"`, 'i').exec(tagText);
  return match ? decodeXml(match[1]!) : undefined;
}

export function stripNumericSuffix(tag: string): string {
  return tag.replace(/\.LIST$/i, '').trim();
}
