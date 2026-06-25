// Cloudflare Pages Function -> /api/extract
// MediaFire + MegaUp direct link extractor (server-side, CORS-free)

export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url);
  const target = searchParams.get('url');

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

  if (!target || !/^https?:\/\//i.test(target)) {
    return json({ error: 'Valid URL required' }, 400);
  }

  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

  try {
    const host = new URL(target).hostname;

    if (host.includes('mediafire.com')) {
      return json({ links: await mediafire(target, UA) });
    }
    if (host.includes('megaup')) {
      return json({ links: await megaup(target, UA) });
    }
    // အခြား host: page ကို scrape ပြီး download link ရှာ
    return json({ links: await generic(target, UA) });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ---------- MediaFire ----------
async function mediafire(url, UA) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  const html = await res.text();
  const links = [];

  // 1) နောက်ဆုံး format: data-scrambled-url="<Base64>"
  const scr = html.match(/data-scrambled-url="([^"]+)"/i);
  if (scr) {
    try {
      const decoded = atob(scr[1]);
      if (/^https?:\/\//.test(decoded)) links.push({ url: decoded });
    } catch (_) {}
  }

  // 2) ဟောင်းတဲ့ format: href="https://download...."
  const href = html.match(/href="((?:https?:)\/\/download[^"]+)"/i);
  if (href && !links.some(l => l.url === href[1])) {
    links.push({ url: href[1] });
  }

  // filename ရှာ
  const fn =
    html.match(/<div class="filename">([^<]+)<\/div>/i) ||
    html.match(/<div class="dl-btn-label"[^>]*title="([^"]+)"/i);
  if (fn && links[0]) links[0].filename = fn[1].trim();

  if (!links.length) {
    throw new Error('MediaFire link မတွေ့ပါ (file ဖျက်ထား/private ဖြစ်နိုင်)');
  }
  return links;
}

// ---------- MegaUp ----------
async function megaup(url, UA) {
  // MegaUp က download_token လိုတတ်တယ်; page ထဲက direct link / form action ရှာ
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  const html = await res.text();
  const links = [];

  const m =
    html.match(/href="((?:https?:)?\/\/[^"]*download_token[^"]*)"/i) ||
    html.match(/href="((?:https?:)\/\/[^"]+\.(?:mp4|mkv|zip|rar|apk|pdf)[^"]*)"/i);
  if (m) {
    let u = m[1];
    if (u.startsWith('//')) u = 'https:' + u;
    links.push({ url: u });
  }
  if (!links.length) throw new Error('MegaUp direct link မတွေ့ပါ');
  return links;
}

// ---------- Generic fallback ----------
async function generic(url, UA) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  // redirect ဖြစ်သွားရင် final URL ကို ပြန်ပေး
  if (res.url && res.url !== url) return [{ url: res.url }];
  const html = await res.text();
  const m = html.match(/href="((?:https?:)\/\/[^"]+\.(?:mp4|mkv|zip|rar|apk|pdf)[^"]*)"/i);
  if (m) return [{ url: m[1] }];
  throw new Error('Direct link မတွေ့ပါ');
}
