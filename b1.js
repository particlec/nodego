import fs from "fs";
import axios from "axios";
import { URL } from "url";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { HttpProxyAgent } from "http-proxy-agent";
import consola from "consola";

// 每日 签到和 保持在线
// clientKey 自行获取 ，https://yescaptcha.com/i/ZU03TV



// 常量
const Config = {
    REQUEST_TIMEOUT: 30000,
    CLIENT_IP: 30 * 1000,
    PING_COOLDOWN: 120 * 1000,
    TASK_DELAY: 20000,
    CYCLE_INTERVAL: 300000,
    ACCOUNT_FILE: "cookies.json",
    PROXY_FILE: "proxies.txt",
};

let accountManager = [];

const userAgents = [
    "Chrome-Win10",
    "Chrome-Mac",
    "Firefox-Win",
    "Firefox-Mac",
    "Chrome-Linux",
    "Safari-iPhone",
    "Edge-Win",
];


const getRandomUA = () =>
    userAgents[Math.floor(Math.random() * userAgents.length)];

const apiBaseUrl = "https://nodego.ai/api";

// 定义 headers
const headers = {
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "cache-control": "no-cache",
    "content-type": "application/json",
    pragma: "no-cache",
    priority: "u=1, i",
    "sec-ch-ua":
        '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "none",
    "sec-fetch-storage-access": "active",
    "sec-ch-ua-mobile": Math.random() > 0.5 ? "?1" : "?0",
    "sec-ch-ua-platform": ["macOS", "Windows", "Linux"][
        Math.floor(Math.random() * 3)
    ],
};

const sleep = (ms) => {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};




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
            clientKey: "",
            task: {
                type: 'TurnstileTaskProxyless', // 针对 Cloudflare Turnstile 无代理任务
                websiteURL: "https://app.nodego.ai/rewards", // 目标网站
                websiteKey: "0x4AAAAAAA4zgfgCoYChIZf4", // 目标网站验证码 Key，
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


// 账户加载器
const loadAccounts = () => {
    try {
        const accounts = JSON.parse(fs.readFileSync(Config.ACCOUNT_FILE, "utf8"));
        const proxies = fs.existsSync(Config.PROXY_FILE)
            ? fs.readFileSync(Config.PROXY_FILE, "utf8").split("\n").filter(Boolean)
            : [];

        return accounts.map((token, index) => ({
            token: token.trim(),
            proxyUrl: proxies[index] ? `http://${proxies[index]}` : null
        }));
    } catch (error) {
        consola.error("加载账户失败:", error);
        process.exit(1);
    }
};

// 获取用户信息
const getUserInfo = async (token, apiBaseUrl, headers, agent) => {
    try {
        const response = await makeRequest({
            method: "GET",
            url: `${apiBaseUrl}/user/me`,
            headers: {
                ...headers,
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "*/*",
            },
            ...(agent && {
                httpAgent: agent.httpAgent,
                httpsAgent: agent.httpsAgent,
            }),
            timeout: Config.REQUEST_TIMEOUT,
        });

        const metadata = response.data.metadata;
        return {
            username: metadata.username,
            email: metadata.email,
            refCode: metadata.refCode,
            totalPoint: metadata.rewardPoint,
            socialTasks: metadata.socialTask || [],
            nodes: metadata.nodes.filter((node) => node.updatedAt).map((node) => {
                if (node.updatedAt) {
                    return {
                        id: node.id,
                        totalPoint: node.totalPoint,
                        todayPoint: node.todayPoint,
                        isActive: node.isActive,
                    };
                }
            }),
        };
    } catch (error) {
        consola.error("获取用户信息失败:", error.message);
        throw error;
    }
};

// 创建代理代理
const createProxyAgent = (proxyUrl) => {
    try {
        const parsedUrl = new URL(proxyUrl);
        if (proxyUrl.startsWith("socks")) {
            return new SocksProxyAgent(parsedUrl);
        } else if (proxyUrl.startsWith("http")) {
            return {
                httpAgent: new HttpProxyAgent(parsedUrl),
                httpsAgent: new HttpsProxyAgent(parsedUrl),
            };
        } else {
            const httpUrl = `http://${proxyUrl}`;
            const httpParsedUrl = new URL(httpUrl);
            return {
                httpAgent: new HttpProxyAgent(httpParsedUrl),
                httpsAgent: new HttpsProxyAgent(httpParsedUrl),
            };
        }
    } catch (error) {
        consola.error("无效的代理 URL:", error.message);
        return null;
    }
};

// 发送请求
const makeRequest = async (config) => {
    try {
        return await axios(config);
    } catch (error) {
        consola.error("请求失败:", error.message);
        throw error;
    }
};

// 每日签到
const checkin = async (apiBaseUrl, token, headers, agent, captcha) => {
    try {
        const response = await makeRequest({
            method: "POST",
            url: `${apiBaseUrl}/user/checkin`,
            headers: {
                ...headers,
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "*/*",
            },
            ...(agent && {
                httpAgent: agent.httpAgent,
                httpsAgent: agent.httpsAgent,
            }),

            data: JSON.stringify({ captcha: captcha }), // 明确指定键和值
            timeout: Config.REQUEST_TIMEOUT,
        });

        return response;
    } catch (error) {
        consola.error("签到失败:", error.message);
        throw error;
    }
};



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





const getCheckinResult = async (proxy) => {
    try {
        // 1. 创建验证码任务
        const taskId = await createTask(null, null, proxy, null);
        if (!taskId) {
            console.error(`创建验证码任务失败`);
            return null;
        } else {
            // 2. 轮询获取验证码任务结果
            const taskResult = await getTaskResultWithRetry(clientKey, taskId);
            if (!taskResult || !taskResult.solution) {
                console.error(`验证码任务解决失败`);
                return null;
            }
            const { token: captchaToken } = taskResult.solution;
            console.log(`获取到验证码 token: ${captchaToken}`);
            return captchaToken
        }

    } catch (error) {
        console.error(`登录过程中发生错误:`, error.message);
        return null;
    }
}




// 重试签到
const retryCheckin = async (
    apiBaseUrl,
    token,
    headers,
    agent,
    maxRetries = 6
) => {
    let retries = 0;
    let response;
    let captchaToken;
    while (retries < maxRetries) {
        try {
            captchaToken = await getCheckinResult(agent);
            response = await checkin(apiBaseUrl, token, headers, agent, captchaToken);
            console.log("response", response);
            if (response.data.statusCode == 201 || response.statusCode == 201) {
                consola.success(`签到成功，状态码: ${response.status}`);
                return response;
            } else {
                consola.warn(`签到返回非预期状态码: ${response.status}，重试中...`);
                await sleep(Config.TASK_DELAY);
                retries++;
            }
        } catch (error) {
            // 检查 error.message 是否包含 400
            if (error.message.includes('400')) {
                consola.success(`签到成功，状态码: 400`);
                return { status: 400 }; // 模拟返回一个状态码为 400 的响应
            } else {
                consola.error(`签到失败: ${error.message}，重试中...`);

                await sleep(Config.TASK_DELAY);
                retries++;
            }
        }
    }

    consola.error("签到失败，达到最大重试次数");
    // throw new Error("签到失败，达到最大重试次数");
};


// Ping节点
const pingNode = async (headers, agent) => {
    try {
        const response = await makeRequest({
            method: "POST",
            url: `${apiBaseUrl}/user/nodes/ping`,
            headers: {
                ...headers,
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "*/*",
                "User-Agent": getRandomUA(),
            },
            data: {
                type: "extension",
            },
            ...(agent && {
                httpAgent: agent.httpAgent,
                httpsAgent: agent.httpsAgent,
            }),
            timeout: Config.REQUEST_TIMEOUT,
        });

        consola.success(`Ping成功，状态码: ${response.status}`);

        const userInfo = await getUserInfo(token, apiBaseUrl, headers, agent);
        await userInfo.nodes.map(node => {
            return consola.success(`用户${userInfo.username}节点${node.id}，今日获得点数: ${node.todayPoint}`);
        })

        return response;
    } catch (error) {
        consola.error("Ping失败:", error.message);
        throw error;
    }
};

// 重试Ping
const pingOnce = async (apiBaseUrl, token, headers, agent) => {
    try {
        const response = await makeRequest({
            method: "POST",
            url: `${apiBaseUrl}/user/nodes/ping`,
            headers: {
                ...headers,
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "*/*",
                "User-Agent": getRandomUA(),
            },
            data: { type: "extension" },
            ...(agent && {
                httpAgent: agent.httpAgent,
                httpsAgent: agent.httpsAgent,
            }),
            timeout: Config.REQUEST_TIMEOUT,
        });

        consola.success(
            `Ping成功（第 ${new Date().toISOString()}）:`,
            `状态码: ${response.status}`
        );

        const userInfo = await getUserInfo(token, apiBaseUrl, headers, agent);
        await userInfo.nodes.map(node => {
            return consola.success(`用户${userInfo.username}节点${node.id}，今日获得点数: ${node.todayPoint}`);
        })
        return response;
    } catch (error) {
        consola.error(
            `Ping失败（第 ${new Date().toISOString()}）:`,
            `错误信息: ${error.message}`,
            `原始错误: ${error.stack ? error.stack.slice(0, 5) : ""}`
        );
        //   throw error;
    }
};

// 封装带重试的请求函数
const retryFetchUserInfo = async (
    token,
    apiBaseUrl,
    headers,
    agent,
    maxRetries = 4,
    delay = 10000
) => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const userInfo = await getUserInfo(token, apiBaseUrl, headers, agent);
            const todayPointAll = userInfo.nodes.reduce(
                (acc, node) => acc + node.todayPoint,
                0
            );

            if (todayPointAll > 0) {
                consola.success(`第 ${attempt} 次重试成功，今日点数: ${todayPointAll}`);
                return userInfo;
            } else {
                consola.warn(
                    `第 ${attempt} 次重试失败，等待 ${delay / 1000} 秒后重试...`
                );
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        } catch (error) {
            consola.error(`第 ${attempt} 次重试发生错误:`, error.message);
            if (attempt === maxRetries) throw error;
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    throw new Error(`重试 ${maxRetries} 次后仍未获取到今日点数`);
};




// 主程序
const main = async (account) => {
    const agent = createProxyAgent(account.proxyUrl);
    const token = account.token;
    const min = 5 * 60 * 1000;  // 5分钟
    const max = 20 * 60 * 1000;  // 7分钟
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;


    const scheduleCheckin = async () => {
        try {
            await retryCheckin(apiBaseUrl, token, headers, agent);
        } catch (error) {
            consola.error("签到失败:", error.message);
        }
        setTimeout(scheduleCheckin, 24 * 60 * 60 * 1000); // 递归调用
    };

    try {
        // 获取用户信息
        const userInfo = await getUserInfo(token, apiBaseUrl, headers, agent);

        consola.success("获取用户信息成功:", userInfo);
        let todayPointAll = userInfo.nodes.reduce(
            (acc, node) => acc + node.todayPoint,
            0
        );

        console.log(`用户名: ${userInfo.username}总点数: ${userInfo.totalPoint}`);

        if (todayPointAll > 0) {
            consola.success("今日已获取点数:", todayPointAll);
        } else {
            consola.info("今日点数未获取，启动重试机制...");
            const retriedUserInfo = await retryFetchUserInfo(
                token,
                apiBaseUrl,
                headers,
                agent
            );
            todayPointAll = retriedUserInfo.nodes.reduce(
                (acc, node) => acc + node.todayPoint,
                0
            );
            consola.success("最终获取今日点数:", todayPointAll);
        }

        // 每日签到
        await scheduleCheckin();




        await pingOnce(apiBaseUrl, token, headers, agent);


        // 添加每5分钟自动 Ping 的定时器，保持连接
        setInterval(async () => {
            try {
                await pingOnce(apiBaseUrl, token, headers, agent);
            } catch (error) {
                consola.error("定时 Ping 失败:", error.message);
            }
        }, delay); // 每300000ms执行一次
    } catch (error) {
        consola.error("程序运行出错:", error.message);
    }
};


const run = async () => {
    try {
        // 加载账号信息
        const accountManager = await loadAccounts();

        // 并发运行每个账号的任务
        const tasks = accountManager.map((account) => main(account));
        await Promise.all(tasks);

        consola.success("所有账号任务已启动");
    } catch (error) {
        consola.error("启动程序出错:", error.message);
    }
};

// 启动程序
run();

