// Netlify Function: /.netlify/functions/add
// 支持两种模式：
// 1. GET/POST JSON: amount, category, note 参数（原有模式）
// 2. POST multipart: image 字段（截图 OCR 模式）

let cachedToken = null;
let tokenExpiry = 0;

async function getFeishuToken(appId, appSecret) {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 300000) {
    return cachedToken;
  }
  const resp = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }
  );
  const data = await resp.json();
  if (data.code !== 0) throw new Error('Token error: ' + data.msg);
  cachedToken = data.tenant_access_token;
  tokenExpiry = now + (data.expires_in || 7200) * 1000;
  return cachedToken;
}

async function addRecord(appId, appSecret, appToken, tableId, amount, category, note) {
  const token = await getFeishuToken(appId, appSecret);
  const now = new Date();
  const fields = {
    '备注': note || '',
    '分类': category || '其他',
    '时间': now.toTimeString().slice(0, 8),
    '日期': Math.floor(now.getTime() / 1000),
    '金额': parseFloat(amount) || 0,
  };
  const resp = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    }
  );
  const data = await resp.json();
  if (!resp.ok || data.code !== 0) {
    throw new Error('Bitable error: ' + JSON.stringify(data));
  }
  return data.data?.record?.record_id;
}

// 从 OCR 文本中提取金额
function extractAmount(text) {
  // 匹配 -317.57 或 ¥317.57 或 ￥317.57 等格式
  const patterns = [
    /[-¥￥]?\d{1,6}\.\d{2}/,
    /金额[：:]\s*([¥￥]?\d+\.?\d*)/,
    /支付[：:]\s*([¥￥]?\d+\.?\d*)/,
    /(\d{1,6}\.\d{2})\s*(元|CNY)?/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      let val = m[1] || m[0];
      val = val.replace(/[¥￥]/g, '');
      const num = parseFloat(val);
      if (num > 0 && num < 1000000) return num;
    }
  }
  return null;
}

// 从 OCR 文本中推断分类
function inferCategory(text) {
  const rules = [
    { keywords: ['餐饮', '外卖', '美团', '饿了么', '美食', '食堂', '饭馆', '餐厅', '小吃', '咖啡', '奶茶', '肯德基', '麦当劳', '星巴克'], cat: '餐饮' },
    { keywords: ['滴滴', '打车', '地铁', '公交', '加油', '停车', '高铁', '火车', '飞机', '出租车', '共享单车', '高德', '百度地图'], cat: '交通' },
    { keywords: ['淘宝', '天猫', '京东', '拼多多', '购物', '超市', '便利店', '711', '全家', '永辉', '沃尔玛', '优衣库', '家居家装'], cat: '购物' },
    { keywords: ['电影', '游戏', '视频', '音乐', '娱乐', 'KTV', '抖音', '直播', '会员', '爱奇艺', '腾讯视频', 'B站'], cat: '娱乐' },
    { keywords: ['房租', '水电', '燃气', '物业', '宽带', '话费', '手机充值', '网费'], cat: '居住' },
    { keywords: ['医院', '药店', '看病', '体检', '药'], cat: '医疗' },
    { keywords: ['教育', '培训', '课程', '书', '书店', '学校', '学费'], cat: '教育' },
  ];
  for (const r of rules) {
    if (r.keywords.some(k => text.includes(k))) return r.cat;
  }
  return '其他';
}

// 解析 multipart form-data（手动解析，无依赖）
function parseMultipart(body, boundary) {
  const fields = {};
  const parts = body.split(`--${boundary}`);
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const header = part.slice(0, headerEnd);
    const content = part.slice(headerEnd + 4).replace(/\r\n$/, '');
    const nameMatch = header.match(/name="([^"]+)"/);
    if (nameMatch) {
      fields[nameMatch[1]] = content;
    }
  }
  return fields;
}

exports.handler = async function (event, context) {
  const { appId, appSecret, appToken, tableId } = process.env;
  const origin = event.headers.origin || '*';

  // CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }

  try {
    let amount, category, note;

    // 模式 1: 图片上传（OCR 模式）
    const contentType = event.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data') && event.body) {
      // 解析 base64 图片（iOS 快捷指令 POST 表单时图片是 base64）
      // iOS Shortcuts 发送图片时会用 multipart，但图片数据可能需要特殊处理
      // 这里我们用简单方式：尝试从 body 中提取信息

      // 如果是 base64 编码的图片数据
      const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;

      // 尝试提取图片中的文字（使用简单的启发式方法）
      // 注意：Netlify Functions 无法直接做 OCR，这里返回提示
      // 实际方案：iOS 端先 OCR，再传文本结果

      // 检查是否有 image 字段或纯图片数据
      if (body.length > 1000) {
        // 这是图片数据，无法在服务端 OCR
        // 返回提示让 iOS 端先做 OCR 再传结果
        return {
          statusCode: 400,
          headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'IMAGE_MODE',
            message: '服务端不支持直接 OCR，请在快捷指令中使用「识别图像中的文本」后以 JSON 方式发送结果',
          }),
        };
      }

      // 尝试作为表单解析
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
      if (boundaryMatch) {
        const fields = parseMultipart(body, (boundaryMatch[1] || boundaryMatch[2]).trim());
        if (fields.text) {
          // iOS 端已 OCR，传了文本
          amount = extractAmount(fields.text);
          category = inferCategory(fields.text);
          note = fields.text.slice(0, 200);
        } else if (fields.image) {
          return {
            statusCode: 400,
            headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: '请先在快捷指令中 OCR 识别图片，再发送文本结果' }),
          };
        }
      }
    }

    // 模式 2: JSON body
    if (!amount && event.body) {
      try {
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        if (body.amount) {
          amount = body.amount;
          category = body.category || inferCategory(body.note || '');
          note = body.note || '';
        } else if (body.text) {
          // OCR 文本模式
          amount = extractAmount(body.text);
          category = inferCategory(body.text);
          note = body.text.slice(0, 200);
        }
      } catch (e) {
        // not json, ignore
      }
    }

    // 模式 3: query params（原有模式）
    if (!amount) {
      const params = event.queryStringParameters || {};
      amount = params.amount;
      category = params.category;
      note = params.note;
    }

    if (!amount) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'missing amount', hint: '提供 amount 参数或上传包含金额的 OCR 文本' }),
      };
    }

    const recordId = await addRecord(appId, appSecret, appToken, tableId, amount, category, note);
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'ok',
        record_id: recordId,
        amount: amount,
        category: category || '其他',
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
