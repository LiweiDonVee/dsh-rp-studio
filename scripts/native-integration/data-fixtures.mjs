import { deflateSync } from 'node:zlib'

function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) } return (crc ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), checksum = Buffer.alloc(4)
  size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([size, body, checksum])
}
function cardPng(raw) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('tEXt', Buffer.from(`chara\0${Buffer.from(raw).toString('base64')}`, 'latin1')), chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))), chunk('IEND', Buffer.alloc(0))])
}
function textPdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 700] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 700] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  for (const text of ['Harbor alpha: public synthetic document.', 'Observatory beta: second page reference.']) { const stream = `BT /F1 14 Tf 40 640 Td (${text}) Tj ET\n`; objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`) }
  let output = '%PDF-1.4\n', offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const start = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(output)
}
export function syntheticStoryData() {
  const opening = '雨落在客栈门廊，林遥等候旅人交来密封信件。'
  const cardJson = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '林遥与雾港', description: '公开合成固定角色来源：林遥是守信的港口向导。', personality: '沉稳，重视约定。', scenario: '旅人在雨中的港口客栈抵达。', first_mes: opening, alternate_greetings: ['UNSELECTED_OPENING_NOT_HISTORY'], mes_example: '<START>\n{{user}}: EXAMPLE_NOT_HISTORY\n{{char}}: 这仅是风格示例。', creator: 'Public synthetic native acceptance', creator_notes: 'No private data or executable instructions.', character_book: { name: '公开合成角色资料', entries: [{ id: 0, keys: ['林遥', '信件'], content: '林遥是雾港的向导；实际信件归属以已结算事实为准。', enabled: true, constant: true }] }, extensions: { regex_scripts: [{ findRegex: 'NEVER_RUN_SYNTHETIC_EXTENSION', replaceString: 'inert source data' }] } } })
  const entries = [{ id: '0', title: '客栈工作资料', content: '密封信件在客栈中交接；只按本轮实际事实写作。', keywords: ['信件', '客栈'], mode: 'required' }, ...Array.from({ length: 40 }, (_, index) => ({ id: `decoy-${index}`, title: `信件背景 ${index}`, content: `合成信件与港口背景 ${index}；不改变持有人。`, keywords: ['信件', '客栈'], mode: 'auto' })), { id: 'outside', title: '埋藏观测台', content: 'buried-observatory: the public chart marks a stairway below the east quay.', keywords: ['buried-observatory'], mode: 'auto' }, { id: 'disabled', title: '禁用合成条目', content: 'DISABLED_NATIVE_PROVIDER_SENTINEL', keywords: ['信件'], mode: 'disabled' }, { id: 'readonly', title: '固定约束', content: '人类锁定的公开资料保持不变。', readOnly: true, mode: 'required' }]
  return { cardJson, png: cardPng(cardJson), opening, persona: { name: '旅人', description: '公开合成玩家身份：持有一封密封信件的来访者。' }, initialScene: { schemaVersion: 1, title: '雨中抵达', location: '港口客栈', time: '清晨', presentActorIds: [] }, initialFacts: { schemaVersion: 1, items: [{ id: 'letter-holder', text: '密封信件当前由旅人持有。' }] }, worldJson: JSON.stringify({ name: '公开合成世界工作资料', entries }), documents: [{ name: 'public-harbor.txt', mimeType: 'text/plain', bytes: Buffer.from('Harbor reference paragraph one.\n\nThe public quay closes at dusk.') }, { name: 'public-harbor.md', mimeType: 'text/markdown', bytes: Buffer.from('# Public harbor\n\nA synthetic document, independent of current facts.') }, { name: 'public-harbor.pdf', mimeType: 'application/pdf', bytes: textPdf() }] }
}
