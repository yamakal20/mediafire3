/**
 * Cloudflare Pages Function
 * POST /api/extract
 * Body: { url: "https://www.mediafire.com/file/..." }
 *
 * Strategy:
 *  1. Validate MediaFire URL
 *  2. Fetch the MediaFire page with browser-like headers (server-side, no CORS)
 *  3. Parse HTML to extract:
 *       a) id="downloadButton" href="..."  ← main method
 *       b) aria-label="Download file" href (fallback)
 *       c) data-url / data-href on download elements (fallback)
 *       d) JSON-embedded download URL in <script> blocks (fallback)
 *  4. Extract file name, size, type from HTML meta / page content
 *  5. Return JSON { directUrl, fileName, fileSize, fileType }
 */

export async function onRequestPost(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };

  // ── Parse request body ────────────────────────────────────────────────────
  let body;
  try {
    body = await context.request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid request body. Expected JSON with a "url" field.' }),
      { status: 400, headers: corsHeaders }
    );
  }

  const { url } = body;

  // ── Validate ──────────────────────────────────────────────────────────────
  if (!url || typeof url !== 'string') {
    return new Response(
      JSON.stringify({ error: 'Missing "url" field in request body.' }),
      { status: 400, headers: corsHeaders }
    );
  }

  const trimmedUrl = url.trim();

  if (!isValidMediaFireUrl(trimmedUrl)) {
    return new Response(
      JSON.stringify({
        error:
          'Invalid MediaFire URL. Please use a URL in the format: https://www.mediafire.com/file/FILEID/FILENAME/file',
      }),
      { status: 400, headers: corsHeaders }
    );
  }

  // ── Fetch MediaFire page ──────────────────────────────────────────────────
  let html;
  try {
    html = await fetchMediaFirePage(trimmedUrl);
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: `Failed to reach MediaFire: ${err.message}. The file may be unavailable or removed.`,
      }),
      { status: 502, headers: corsHeaders }
    );
  }

  // ── Check for known error states ──────────────────────────────────────────
  const errorState = detectPageError(html);
  if (errorState) {
    return new Response(
      JSON.stringify({ error: errorState }),
      { status: 404, headers: corsHeaders }
    );
  }

  // ── Extract direct download URL ───────────────────────────────────────────
  const directUrl = extractDirectUrl(html);

  if (!directUrl) {
    return new Response(
      JSON.stringify({
        error:
          'Could not extract the direct download link. MediaFire may have changed their page structure, or the file requires a login / is password protected.',
      }),
      { status: 422, headers: corsHeaders }
    );
  }

  // ── Extract file metadata ─────────────────────────────────────────────────
  const { fileName, fileSize, fileType } = extractFileInfo(html, trimmedUrl);

  return new Response(
    JSON.stringify({ directUrl, fileName, fileSize, fileType }),
    { status: 200, headers: corsHeaders }
  );
}

// OPTIONS preflight
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper: Validate URL
// ═══════════════════════════════════════════════════════════════════════════
function isValidMediaFireUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === 'www.mediafire.com' || parsed.hostname === 'mediafire.com') &&
      parsed.pathname.includes('/file/')
    );
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper: Fetch MediaFire page with browser-like headers
// ═══════════════════════════════════════════════════════════════════════════
async function fetchMediaFirePage(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
        Connection: 'keep-alive',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    return text;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out after 15 seconds');
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper: Detect MediaFire error pages
// ═══════════════════════════════════════════════════════════════════════════
function detectPageError(html) {
  // File not found / deleted
  if (
    html.includes('File Not Found') ||
    html.includes('file not found') ||
    html.includes('The key you provided') ||
    html.includes('does not exist') ||
    html.includes('Invalid or Deleted File')
  ) {
    return 'File not found or has been deleted from MediaFire.';
  }

  // Error page
  if (html.includes('404 Not Found') || html.includes('error-page')) {
    return 'MediaFire returned a 404 error. The file may have been deleted.';
  }

  // Password protected
  if (
    html.includes('password_form') ||
    html.includes('password-form') ||
    html.includes('Enter password') ||
    html.includes('password protected')
  ) {
    return 'This file is password protected. Cannot extract direct link.';
  }

  // Virus scan / infected
  if (html.includes('This file has been reported') || html.includes('report_file')) {
    return 'This file has been flagged by MediaFire and is unavailable.';
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper: Extract direct download URL from HTML
// Uses multiple strategies in priority order
// ═══════════════════════════════════════════════════════════════════════════
function extractDirectUrl(html) {
  // ── Strategy 1: id="downloadButton" href="URL" ────────────────────────────
  // Classic MediaFire HTML: <a id="downloadButton" href="https://download...">
  const downloadButtonPatterns = [
    /href="(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"\s+[^>]*id="downloadButton"/i,
    /id="downloadButton"\s+[^>]*href="(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/i,
    /<a[^>]+id="downloadButton"[^>]*href="(https?:\/\/[^"]+)"/i,
    /<a[^>]+href="(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"[^>]*id="downloadButton"/i,
  ];

  for (const pattern of downloadButtonPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return decodeHTMLEntities(match[1]);
    }
  }

  // ── Strategy 2: aria-label Download + href ────────────────────────────────
  const ariaPatterns = [
    /href="(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"\s+[^>]*aria-label="[^"]*[Dd]ownload[^"]*"/i,
    /aria-label="[^"]*[Dd]ownload[^"]*"\s+[^>]*href="(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/i,
  ];

  for (const pattern of ariaPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return decodeHTMLEntities(match[1]);
    }
  }

  // ── Strategy 3: Any download.mediafire.com link in href ───────────────────
  const genericHrefPattern =
    /href="(https?:\/\/download\d+\.mediafire\.com\/[a-zA-Z0-9\/\-_+%]+\/[^"?#]+)"/i;
  const genericMatch = html.match(genericHrefPattern);
  if (genericMatch && genericMatch[1]) {
    return decodeHTMLEntities(genericMatch[1]);
  }

  // ── Strategy 4: data-url or data-href attributes ──────────────────────────
  const dataAttrPatterns = [
    /data-url="(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/i,
    /data-href="(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/i,
    /data-download="(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/i,
  ];

  for (const pattern of dataAttrPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return decodeHTMLEntities(match[1]);
    }
  }

  // ── Strategy 5: JavaScript / JSON embedded URL ────────────────────────────
  // MediaFire sometimes puts the URL inside a <script> block as JSON or a
  // variable assignment
  const jsPatterns = [
    /"dllink"\s*:\s*"(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/i,
    /"download_url"\s*:\s*"(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/i,
    /dllink\s*=\s*["'](https?:\/\/download\d*\.mediafire\.com\/[^"']+)["']/i,
    /download_url\s*=\s*["'](https?:\/\/download\d*\.mediafire\.com\/[^"']+)["']/i,
    /"url"\s*:\s*"(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/i,
  ];

  for (const pattern of jsPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return decodeHTMLEntities(match[1]);
    }
  }

  // ── Strategy 6: Broad scan for any download*.mediafire.com URL ───────────
  const broadPattern = /(https?:\/\/download\d+\.mediafire\.com\/[^\s"'<>\\]+)/i;
  const broadMatch = html.match(broadPattern);
  if (broadMatch && broadMatch[1]) {
    // Clean up trailing HTML entities or punctuation
    let found = broadMatch[1]
      .replace(/&amp;/gi, '&')
      .replace(/[)"'\\\s]+$/, '');
    return found;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper: Extract file name, size, type from HTML
// ═══════════════════════════════════════════════════════════════════════════
function extractFileInfo(html, originalUrl) {
  let fileName = '';
  let fileSize = '';
  let fileType = '';

  // ── File Name ─────────────────────────────────────────────────────────────
  // 1. <title> tag
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    let title = titleMatch[1].trim();
    // MediaFire title is usually just the filename (no "| MediaFire" suffix)
    title = title.replace(/\s*[|\-–]\s*MediaFire\s*$/i, '').trim();
    if (title && title.length > 0 && title !== 'MediaFire') {
      fileName = title;
    }
  }

  // 2. og:title
  if (!fileName) {
    const ogTitleMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    if (ogTitleMatch) {
      fileName = ogTitleMatch[1].trim();
    }
  }

  // 3. From URL path as last resort
  if (!fileName) {
    try {
      const parsed = new URL(originalUrl);
      const parts = parsed.pathname.split('/').filter(Boolean);
      // URL format: /file/FILEID/FILENAME/file
      // FILENAME is typically at index 2
      if (parts.length >= 3) {
        fileName = decodeURIComponent(parts[2]);
      }
    } catch {
      // ignore
    }
  }

  // ── File Size ──────────────────────────────────────────────────────────────
  // Patterns like: 846.94 MB, 1.2 GB, 512 KB
  const sizePatterns = [
    /File size[:\s]+([0-9.,]+\s*(?:B|KB|MB|GB|TB))/i,
    /([0-9.,]+\s*(?:GB|MB|KB|B))\s*(?:<|·|•|\|)/i,
    /"fileSize"\s*:\s*"([^"]+)"/i,
    /size["\s:]+([0-9.,]+\s*(?:GB|MB|KB|B))/i,
    // Match patterns like "846.94MB" in HTML
    /\b([0-9]+(?:\.[0-9]+)?\s*(?:GB|MB|KB|B))\b/i,
  ];

  for (const pattern of sizePatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      const candidate = match[1].trim();
      // Filter out obviously wrong matches (CSS values etc.)
      if (!/px|em|rem|vw|vh/.test(candidate)) {
        fileSize = candidate;
        break;
      }
    }
  }

  // ── File Type ──────────────────────────────────────────────────────────────
  // From extension in file name
  if (fileName) {
    const extMatch = fileName.match(/\.([a-zA-Z0-9]+)$/);
    if (extMatch) {
      fileType = extMatch[1].toUpperCase();
    }
  }

  // From page content
  if (!fileType) {
    const typePatterns = [
      /Video\s*\(\.([A-Z0-9]+)\)/i,
      /Audio\s*\(\.([A-Z0-9]+)\)/i,
      /Document\s*\(\.([A-Z0-9]+)\)/i,
      /Archive\s*\(\.([A-Z0-9]+)\)/i,
      /"fileType"\s*:\s*"([^"]+)"/i,
    ];
    for (const pattern of typePatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        fileType = match[1].toUpperCase();
        break;
      }
    }
  }

  return { fileName, fileSize, fileType };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper: Decode HTML entities in URLs
// ═══════════════════════════════════════════════════════════════════════════
function decodeHTMLEntities(str) {
  return str
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x3D;/gi, '=');
}
