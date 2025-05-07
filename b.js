import fs from "fs";
import axios from "axios";

//   通过账号密码批量获取token的js，     ulist.txt --------->gettoken.json
//    clientKey 自行获取


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 创建验证码任务
 * @param {string} clientKey - YesCaptcha 平台 API Key
 * @param {string} websiteURL - 目标登录接口 URL
 * @param {string|null} proxy - 如不使用代理传空字符串
 * @param {boolean} waitLoad - 是否等待页面加载完成
 * @returns {Promise<string|null>} - 返回 taskId，如果失败返回 null
 */
async function createTask(clientKey, websiteURL, proxy, waitLoad) {
  try {
    const response = await axios.post('https://api.yescaptcha.com/createTask', {
      clientKey: clientKey,
      task: {
        type: 'TurnstileTaskProxyless', // 针对 Cloudflare Turnstile 无代理任务
        websiteURL: websiteURL,
        websiteKey: "0x4AAAAAAA4zgfgCoYChIZf4", // 目标网站验证码 Key
        proxy: proxy,
      }
    });

    if (response.data && response.data.taskId) {
      console.log(`验证码任务创建成功，taskId: ${response.data.taskId}`);
      return response.data.taskId;
    } else {
      console.error('创建验证码任务返回格式异常:', response.data);
      return null;
    }
  } catch (error) {
    console.error('创建验证码任务失败:', error.message);
    return null;
  }
}

/**
 * 获取验证码任务结果
 * @param {string} clientKey - YesCaptcha 平台 API Key
 * @param {string} taskId - 创建任务返回的 taskId
 * @returns {Promise<Object|null>} - 返回任务结果对象
 */
async function getTaskResult(clientKey, taskId) {
  try {
    const response = await axios.post('https://api.yescaptcha.com/getTaskResult', {
      clientKey: clientKey,
      taskId: taskId
    });
    if (response.data.errorId === 0) {
      console.log('验证码任务返回:', response.data);
      return response.data;
    } else {
      console.log('验证码任务未完成或返回错误:', response.data);
      return response.data;
    }
  } catch (error) {
    console.error('获取验证码任务结果失败:', error.message);
    return null;
  }
}

/**
 * 带重试的轮询获取验证码任务结果
 * @param {string} clientKey - YesCaptcha 平台 API Key
 * @param {string} taskId - 任务 ID
 * @param {number} maxRetries - 重试次数上限（默认15次，每次间隔8秒）
 * @returns {Promise<Object>} - 返回最终的任务结果对象
 */
async function getTaskResultWithRetry(clientKey, taskId, maxRetries = 15) {
  while (maxRetries > 0) {
    const result = await getTaskResult(clientKey, taskId);
    if (!result) {
      throw new Error("无法获取任务结果");
    }
    if (result.status !== 'processing') { 
      return result;
    }
    console.log(`验证码状态：${result.status}，剩余重试次数：${maxRetries}`);
    await sleep(8000); // 等待 8 秒后继续轮询
    maxRetries--;
  }
  throw new Error("超出最大重试次数仍未获取验证码结果");
}

/**
 * 使用单个账号进行验证码解决及登录，返回 accessToken
 * @param {string} email - 账号邮箱
 * @param {string} password - 密码
 * @param {string} clientKey - YesCaptcha API Key
 * @param {string} websiteURL - 登录接口 URL
 * @param {string|null} proxy - 代理设置，如不需要传空字符串
 * @param {boolean} waitLoad - 是否等待页面加载完成
 * @returns {Promise<string|null>} - 返回登录 accessToken（若成功）否则 null
 */
async function loginAccount(email, password, clientKey, websiteURL, proxy, waitLoad) {
  try {
    // 1. 创建验证码任务
    const taskId = await createTask(clientKey, websiteURL, proxy, waitLoad);
    if (!taskId) {
      console.error(`${email}：创建验证码任务失败`);
      return null;
    }
    
    // 2. 轮询获取验证码任务结果
    const taskResult = await getTaskResultWithRetry(clientKey, taskId);
    if (!taskResult || !taskResult.solution) {
      console.error(`${email}：验证码任务解决失败`);
      return null;
    }
    const { token: captchaToken } = taskResult.solution;
    console.log(`${email}：获取到验证码 token: ${captchaToken}`);
  
    // 3. 使用验证码 token 发起登录请求
    const loginPayload = { email, password, captcha: captchaToken };
    const loginResponse = await axios.post(websiteURL, loginPayload);
  
    if (loginResponse.data &&
        loginResponse.data.metadata &&
        loginResponse.data.metadata.accessToken) {
      console.log(`${email}：登录成功，accessToken 获取成功`);
      return loginResponse.data.metadata.accessToken;
    } else {
      console.error(`${email}：登录失败，响应:`, loginResponse.data);
      return null;
    }
  } catch (error) {
    console.error(`${email}：登录过程中发生错误:`, error.message);
    return null;
  }
}

/**
 * 并发处理单个账号
 * @param {Object} account - 账号信息
 * @param {string} clientKey - YesCaptcha API Key
 * @param {string} websiteURL - 登录接口 URL
 * @param {string|null} proxy - 代理设置
 * @param {boolean} waitLoad - 是否等待页面加载完成
 * @returns {Promise<{email: string, token: string}|null>} - 返回账号和 token，或者 null
 */
async function processAccount(account, clientKey, websiteURL, proxy, waitLoad) {
  try {
    const { email, password } = account;
    console.log(`开始处理账号: ${email}`);
    const token = await loginAccount(email, password, clientKey, websiteURL, proxy, waitLoad);
    if (token) {
      return { email, token };
    } else {
      console.error(`${email}：未获取到 token`);
      return null;
    }
  } catch (error) {
    console.error(`处理账号时出错:`, error.message);
    return null;
  }
}

/**
 * 主流程：读取 ulist.txt，遍历每个账号获取 token，然后写入 gettoken.json 文件
 */
async function main() {
  // 配置项
  const config = {
    clientKey: "", // YesCaptcha API Key
    websiteURL: "https://nodego.ai/api/auth/login", // 登录接口 URL
    proxy: "", // 代理设置，如不需要传空字符串
    waitLoad: false // 是否等待页面加载完成
  };

  try {
    // 读取同目录下的 ulist.txt 文件
    const fileContent = fs.readFileSync('ulist.txt', "utf8");
    
    // 每行格式为 email:password，过滤掉空行
    const accounts = fileContent.split(/\r?\n/).filter(line => line.trim() !== "");
    
    // 解析账号信息
    const accountList = accounts.map(line => {
      const [email, password] = line.split(':').map(s => s.trim());
      return { email, password };
    }).filter(account => account.email && account.password);

    // 并发处理每个账号
    const tasks = accountList.map(account => 
      processAccount(account, config.clientKey, config.websiteURL, config.proxy, config.waitLoad)
    );

    // 等待所有任务完成
    const results = await Promise.allSettled(tasks);

    // 提取成功的结果
    const tokens = results
      .filter(result => result.status === "fulfilled" && result.value)
      .map(result => result.value.token);

    // 提取失败的账号
    const failedAccounts = results
      .filter(result => result.status === "rejected" || !result.value)
      .map((result, index) => {
        const account = accountList[index];
        return {
          email: account.email,
          error: result.status === "rejected" ? result.reason : "未获取到 token"
        };
      });

    // 写入所有 token 和失败的账号到 gettoken.json 文件
    const output = {
      success: tokens,
      failed: failedAccounts
    };

    await fs.promises.writeFile('gettoken.json', JSON.stringify(output, null, 2), 'utf8');
    console.log(`\n所有账号处理完毕，共获取到 ${tokens.length} 个 token，结果写入 gettoken.json`);
  } catch (error) {
    console.error("主流程发生错误：", error.message);
  }
}

// 启动程序
main();