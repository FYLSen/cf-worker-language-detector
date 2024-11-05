export interface Env {
  DB: D1Database;
  AI: any;
  AI_MODEL: string;
}

class LanguageDetector {
  private INIT_SQL = `
CREATE TABLE IF NOT EXISTS languages (
  language_code TEXT PRIMARY KEY,
  language_name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`;

  constructor(private env: Env) {}

  async initDatabase() {
    await this.env.DB.prepare(this.INIT_SQL);
  }

  async getLanguageFromDB(languageCode: string): Promise<string | null> {
    const result = await this.env.DB.prepare(
      'SELECT language_name FROM languages WHERE language_code = ?'
    ).bind(languageCode).first();
    return result ? result.language_name : null;
  }

  async saveLanguageToDB(languageCode: string, languageName: string) {
    await this.env.DB.prepare(
      'INSERT INTO languages (language_code, language_name) VALUES (?, ?)'
    ).bind(languageCode, languageName);
  }

  async detectLanguageWithAI(languageCode: string): Promise<string> {
    const prompt = `
Your task is to identify and return the language name in English for the given language code: "${languageCode}".

Rules:
- Return the language name in English (e.g., "English (United States)", "Chinese (Simplified, China)", "Japanese").
- Do not include any additional text or explanation.
- Use widely accepted standard language names.
- If the code is invalid or unknown, return "Unknown".

Example responses:
- For "en": English
- For "en-US": English (United States)
- For "zh": Chinese
- For "zh-CN": Chinese (Simplified, China)
- For "ja": Japanese
`;

    const response = await this.env.AI.run(this.env.AI_MODEL, {
      messages: [
        { role: 'user', content: prompt }
      ]
    });

    return response.response.trim();
  }

  parseAcceptLanguage(acceptLanguage: string | null): string | null {
    if (!acceptLanguage) {
      return null;
    }

    // 解析 accept-language 字段
    // 示例: "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6"
    const languages = acceptLanguage.split(',')
      .map(lang => {
        const [code, qValue] = lang.trim().split(';');
        return {
          code: code.trim(),
          // 如果没有 q 值，默认为 1.0
          q: qValue ? parseFloat(qValue.split('=')[1]) : 1.0
        };
      })
      .sort((a, b) => b.q - a.q); // 按 q 值降序排序

    // 返回权重最高的语言代码
    return languages.length > 0 ? languages[0].code : null;
  }

  normalizeLanguageCode(code: string): string {
    // 移除可能的权重信息
    code = code.split(';')[0].trim();
    
    // 确保使用标准格式（如果是短格式，保持原样）
    // 例如：zh-CN, en-US 保持不变，zh 也保持不变
    return code;
  }

  async handleRequest(request: Request): Promise<Response> {
    await this.initDatabase();

    // 获取并处理语言代码
    let languageCode = new URL(request.url).searchParams.get('languageCode');
    let type = new URL(request.url).searchParams.get('type');
    
    // 如果 URL 参数中没有 languageCode，则使用 accept-language 头
    if (!languageCode) {
      const acceptLanguage = request.headers.get('accept-language');
      languageCode = this.parseAcceptLanguage(acceptLanguage);
      
      if (!languageCode) {
        return new Response('No language code provided and no valid Accept-Language header found', {
          status: 400
        });
      }
    }

    // 标准化语言代码
    languageCode = this.normalizeLanguageCode(languageCode);

    // 从数据库查询
    let languageName = await this.getLanguageFromDB(languageCode);

    // 如果数据库中不存在，使用AI检测
    if (!languageName) {
      try {
        languageName = await this.detectLanguageWithAI(languageCode);
        // 保存到数据库
        await this.saveLanguageToDB(languageCode, languageName);
      } catch (error) {
        console.error('AI detection error:', error);
        languageName = 'Unknown';
      }
    }
    
    if (type === 'text') {
      return new Response(languageName, {
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'public, max-age=86400'
        }
      });
    } else {
      return new Response(
        JSON.stringify({ languageCode, languageName }), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=86400'
          }
      });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const languageDetector = new LanguageDetector(env);
    return await languageDetector.handleRequest(request);
  }
};