/**
 * Claude API で食品の 100g あたり栄養素を推定し foods に source=ai で追加する。
 * API キーはシートではなくスクリプトプロパティ ANTHROPIC_API_KEY に置く
 * （スクリプトエディタ → プロジェクトの設定 → スクリプト プロパティ）。
 * モデルは settings.ai_model（既定 claude-sonnet-4-6）。
 */
function estimateFoodWithAi(foodName) {
  if (!foodName || !String(foodName).trim()) throw new Error('食品名を入力してください');
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('スクリプトプロパティ ANTHROPIC_API_KEY が未設定です');
  var model = getSettings().ai_model || 'claude-sonnet-4-6';

  var system = [
    'You are a nutrition database. Given a food name (Japanese or English), return typical nutrition per 100 g as edible portion.',
    'Respond with ONLY a JSON object, no prose, no code fence, exactly these keys:',
    '{"name_ja":string,"name_en":string,"kcal":number,"p":number,"f":number,"c":number,"note":string}',
    'p/f/c are grams of protein/fat/carbohydrate per 100 g. note: one short line on the assumption (e.g. cooked vs raw, brand).',
    'If the name is ambiguous, assume the most common preparation and say so in note.'
  ].join('\n');

  var payload = {
    model: model,
    max_tokens: 512,
    system: system,
    messages: [{ role: 'user', content: String(foodName).trim() }]
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code !== 200) throw new Error('Claude API エラー ' + code + ': ' + body.slice(0, 300));
  var msg = JSON.parse(body);
  if (msg.stop_reason === 'refusal') throw new Error('Claude API が応答を拒否しました');
  var text = (msg.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  var est = parseAiJson_(text);
  var row = addFood({ name_ja: est.name_ja || foodName, name_en: est.name_en || '', per: '100g', kcal: est.kcal, p: est.p, f: est.f, c: est.c, source: 'ai', note: est.note || '' });
  return row;
}

/** モデル出力から JSON を取り出す（コードフェンスや前置きがあっても拾う）。 */
function parseAiJson_(text) {
  var s = String(text || '').trim();
  var m = /\{[\s\S]*\}/.exec(s);
  if (!m) throw new Error('AI 応答を解釈できません: ' + s.slice(0, 200));
  var obj = JSON.parse(m[0]);
  ['kcal', 'p', 'f', 'c'].forEach(function (k) {
    obj[k] = Number(obj[k]);
    if (isNaN(obj[k])) throw new Error('AI 応答の ' + k + ' が数値ではありません');
  });
  return obj;
}

if (typeof module !== 'undefined') module.exports = { parseAiJson_: parseAiJson_ };
