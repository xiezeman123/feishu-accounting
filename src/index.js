const FEISHU_APP_ID = FEISHU_APP_ID;
const FEISHU_APP_SECRET = FEISHU_APP_SECRET;
const FEISHU_APP_TOKEN = FEISHU_APP_TOKEN;
const FEISHU_TABLE_ID = FEISHU_TABLE_ID;

// In-memory token cache (Worker memory persists across requests)
let cachedToken = null;
let tokenExpiry = 0;

async function getFeishuToken() {
  const now = Date.now();

  // Use cached token if still valid (refresh 5 min early)
  if (cachedToken && now < tokenExpiry - 300000) {
    return cachedToken;
  }

  const resp = await fetch(
    `https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: FEISHU_APP_ID,
        app_secret: FEISHU_APP_SECRET,
      }),
    }
  );

  if (!resp.ok) {
    throw new Error(`Token fetch failed: ${resp.status}`);
  }

  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`Token error: ${data.msg}`);
  }

  cachedToken = data.tenant_access_token;
  // Feishu tokens last 2 hours (7200s), cache for 1.9 hours
  tokenExpiry = now + (data.expires_in || 7200) * 1000;
  return cachedToken;
}

async function addRecord(amount, category, note) {
  const token = await getFeishuToken();
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const timeStr = now.toTimeString().slice(0, 8);  // HH:MM:SS

  const fields = {
    备注: note || "",
    分类: category || "其他",
    时间: timeStr,
    日期: dateStr,
    金额: parseFloat(amount) || 0,
  };

  const resp = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields }),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Bitable write failed: ${resp.status} - ${errText}`);
  }

  return await resp.json();
}

function makeCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: makeCorsHeaders() });
  }

  if (path === "/add" && request.method === "GET") {
    const amount = url.searchParams.get("amount");
    const category = url.searchParams.get("category");
    const note = url.searchParams.get("note");

    if (!amount) {
      return new Response(
        JSON.stringify({ error: "missing amount" }),
        { status: 400, headers: { "Content-Type": "application/json", ...makeCorsHeaders() } }
      );
    }

    try {
      const result = await addRecord(amount, category, note);
      return new Response(
        JSON.stringify({ status: "ok", record_id: result?.data?.record?.record_id }),
        { headers: { "Content-Type": "application/json", ...makeCorsHeaders() } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json", ...makeCorsHeaders() } }
      );
    }
  }

  // Health check
  if (path === "/health") {
    return new Response(
      JSON.stringify({ status: "ok" }),
      { headers: { "Content-Type": "application/json", ...makeCorsHeaders() } }
    );
  }

  return new Response(
    JSON.stringify({ error: "not found" }),
    { status: 404, headers: { "Content-Type": "application/json", ...makeCorsHeaders() } }
  );
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request);
  },
};
