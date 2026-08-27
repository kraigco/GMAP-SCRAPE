import { zip } from '../lib/zip.ts';
import type { ZipEntry } from '../lib/zip.ts';

/**
 * Write a Word document — Office Open XML, no dependency.
 *
 * A .docx is a ZIP of XML parts. This builds the four that matter: the content
 * types manifest, the package relationships, a stylesheet, and the document
 * body. Word tolerates a good deal of omission, but the parts below are the
 * ones it will not open without.
 *
 * Scope is deliberately narrow — styled paragraphs and page breaks. That is
 * what a letter is. Tables, images, headers and footers are absent because
 * nothing here needs them, and each one is a spec surface that would have to be
 * kept correct forever.
 */

export type DocxStyle = 'Title' | 'Heading1' | 'Heading2' | 'Meta' | 'Body' | 'Mono';

export type DocxParagraph = {
  text: string;
  style?: DocxStyle;
  /** Start this paragraph on a new page — one letter per page, for review. */
  pageBreakBefore?: boolean;
};

/**
 * XML escaping, applied to every value without exception.
 *
 * Business names are the reason: "Smith & Jones", 'O"Brien Realty' and the like
 * arrive straight from a Google listing into this file. One unescaped ampersand
 * produces a document Word refuses to open, and the failure surfaces as a
 * corrupt-file dialog rather than as anything pointing back here.
 */
function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Word drops leading and trailing whitespace in a run unless it is told not to,
 * and collapses an empty paragraph's spacing differently again. `xml:space` is
 * what keeps an indented signature block looking the way it reads here.
 */
function runFor(text: string): string {
  if (text === '') return '<w:r><w:t xml:space="preserve"></w:t></w:r>';
  return `<w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

function paragraphFor(p: DocxParagraph): string {
  const style = p.style ?? 'Body';
  const props = [`<w:pStyle w:val="${style}"/>`];
  if (p.pageBreakBefore) props.push('<w:pageBreakBefore/>');
  return `<w:p><w:pPr>${props.join('')}</w:pPr>${runFor(p.text)}</w:p>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/**
 * Sizes are half-points and spacing is twentieths of a point, which is why
 * every number here looks doubled or twentyfold.
 *
 * The letter body is monospaced on purpose: it is plain-text email, and showing
 * it in a proportional face invites someone to treat it as a document to be
 * formatted rather than as the bytes a recipient will see.
 */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/>
</w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Body" w:default="1"><w:name w:val="Body"/>
<w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>
<w:pPr><w:spacing w:after="240"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
<w:pPr><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
<w:pPr><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Meta"/>
<w:pPr><w:spacing w:after="80"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:color w:val="6B7280"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Mono"><w:name w:val="Mono"/>
<w:pPr><w:spacing w:after="180" w:line="264" w:lineRule="auto"/><w:ind w:left="284"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
</w:styles>`;

export function buildDocx(paragraphs: DocxParagraph[]): Buffer {
  const body = paragraphs.map(paragraphFor).join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(PACKAGE_RELS, 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(DOCUMENT_RELS, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ];

  return zip(entries);
}
