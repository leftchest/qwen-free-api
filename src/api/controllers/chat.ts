import { URL } from "url";
import { PassThrough } from "stream";
import http2 from "http2";
import path from "path";
import _ from "lodash";
import mime from "mime";
import FormData from "form-data";
import axios, { AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from "eventsource-parser";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import serviceConfig from "@/lib/configs/service-config.ts";

// 模型名称
const MODEL_NAME = "qwen";
// 法律咨询模型名称
const LAW_MODEL_NAME = "law";
// 纯文本解题模型名称
const SOLVE_TXT_MODEL_NAME = "solve_txt";
// 图文解题模型名称
const SOLVE_PIC_MODEL_NAME = "solve_pic";
// 数字人视频生成模型名称
const DIGITAL_PEOPLE_MODEL_NAME = "Digital-people";
// 最大重试次数
const MAX_RETRY_COUNT = 3;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Cache-Control": "no-cache",
  Origin: "https://tongyi.aliyun.com",
  Pragma: "no-cache",
  "Sec-Ch-Ua":
    '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  Referer: "https://tongyi.aliyun.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "X-Platform": "pc_tongyi",
  "X-Xsrf-Token": "48b9ee49-a184-45e2-9f67-fa87213edcdc",
};
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;

/**
 * 移除会话
 *
 * 在对话流传输完毕后移除会话，避免创建的会话出现在用户的对话列表中
 *
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 */
async function removeConversation(convId: string, ticket: string) {
  const result = await axios.post(
    `https://qianwen.biz.aliyun.com/dialog/session/delete`,
    {
      sessionId: convId,
    },
    {
      headers: {
        Cookie: generateCookie(ticket),
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  checkResult(result);
}

/**
 * 同步对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 * @param refConvId 引用的会话ID
 * @param retryCount 重试次数
 */
async function createCompletion(
  model = MODEL_NAME,
  messages: any[],
  searchType: string = '',
  ticket: string,
  refConvId = '',
  retryCount = 0
) {
  let session: http2.ClientHttp2Session;
  return (async () => {
    logger.info(messages);

    // 提取引用文件URL并上传qwen获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, ticket))
        )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z]{32}/.test(refConvId))
      refConvId = '';

    // 请求流
    const session: http2.ClientHttp2Session = await new Promise(
      (resolve, reject) => {
        const session = http2.connect("https://qianwen.biz.aliyun.com");
        session.on("connect", () => resolve(session));
        session.on("error", reject);
      }
    );
    const [sessionId, parentMsgId = ''] = refConvId.split('-');
    const req = session.request({
      ":method": "POST",
      ":path": "/dialog/conversation",
      "Content-Type": "application/json",
      Cookie: generateCookie(ticket),
      ...FAKE_HEADERS,
      Accept: "text/event-stream",
    });
    req.setTimeout(120000);
    req.write(
      JSON.stringify({
        mode: "chat",
        model: "",
        action: "next",
        userAction: "chat",
        requestId: util.uuid(false),
        sessionId,
        sessionType: "text_chat",
        parentMsgId,
        params: {
          "fileUploadBatchId": util.uuid(),
          "searchType": searchType,
        },
        contents: messagesPrepare(messages, refs, !!refConvId),
      })
    );
    req.end();
    req.setEncoding("utf8");
    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveStream(req);
    session.close();
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    // 异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
    removeConversation(answer.id, ticket).catch((err) => console.error(err));

    return answer;
  })().catch((err) => {
    session && session.close();
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(model, messages, searchType, ticket, refConvId, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 * @param refConvId 引用的会话ID
 * @param retryCount 重试次数
 */
async function createCompletionStream(
  model = MODEL_NAME,
  messages: any[],
  searchType: string = '',
  ticket: string,
  refConvId = '',
  retryCount = 0
) {
  let session: http2.ClientHttp2Session;
  return (async () => {
    logger.info(messages);

    // 提取引用文件URL并上传qwen获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, ticket))
        )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z]{32}/.test(refConvId))
      refConvId = ''

    // 请求流
    session = await new Promise((resolve, reject) => {
      const session = http2.connect("https://qianwen.biz.aliyun.com");
      session.on("connect", () => resolve(session));
      session.on("error", reject);
    });
    const [sessionId, parentMsgId = ''] = refConvId.split('-');
    const req = session.request({
      ":method": "POST",
      ":path": "/dialog/conversation",
      "Content-Type": "application/json",
      Cookie: generateCookie(ticket),
      ...FAKE_HEADERS,
      Accept: "text/event-stream",
    });
    req.setTimeout(120000);
    req.write(
      JSON.stringify({
        mode: "chat",
        model: "",
        action: "next",
        userAction: "chat",
        requestId: util.uuid(false),
        sessionId,
        sessionType: "text_chat",
        parentMsgId,
        params: {
          "fileUploadBatchId": util.uuid(),
          "searchType": searchType,
        },
        contents: messagesPrepare(messages, refs, !!refConvId),
      })
    );
    req.end();
    req.setEncoding("utf8");
    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(req, (convId: string) => {
      // 关闭请求会话
      session.close();
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
      // 流传输结束后异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
      removeConversation(convId, ticket).catch((err) => console.error(err));
    });
  })().catch((err) => {
    session && session.close();
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(model, messages, searchType, ticket, refConvId, retryCount + 1);
      })();
    }
    throw err;
  });
}

async function generateImages(
  model = MODEL_NAME,
  prompt: string,
  ticket: string,
  retryCount = 0
) {
  let session: http2.ClientHttp2Session;
  return (async () => {
    const messages = [
      { role: "user", content: prompt.indexOf('画') == -1 ? `请画：${prompt}` : prompt },
    ];
    // 请求流
    const session: http2.ClientHttp2Session = await new Promise(
      (resolve, reject) => {
        const session = http2.connect("https://qianwen.biz.aliyun.com");
        session.on("connect", () => resolve(session));
        session.on("error", reject);
      }
    );
    const req = session.request({
      ":method": "POST",
      ":path": "/dialog/conversation",
      "Content-Type": "application/json",
      Cookie: generateCookie(ticket),
      ...FAKE_HEADERS,
      Accept: "text/event-stream",
    });
    req.setTimeout(120000);
    req.write(
      JSON.stringify({
        mode: "chat",
        model: "",
        action: "next",
        userAction: "chat",
        requestId: util.uuid(false),
        sessionId: "",
        sessionType: "text_chat",
        parentMsgId: "",
        params: {
          "fileUploadBatchId": util.uuid()
        },
        contents: messagesPrepare(messages),
      })
    );
    req.end();
    req.setEncoding("utf8");
    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const { convId, imageUrls } = await receiveImages(req);
    session.close();
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );

    // 异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
    removeConversation(convId, ticket).catch((err) => console.error(err));

    return imageUrls;
  })().catch((err) => {
    session && session.close();
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return generateImages(model, prompt, ticket, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 提取消息中引用的文件URL
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
function extractRefFileUrls(messages: any[]) {
  const urls = [];
  // 如果没有消息，则返回[]
  if (!messages.length) {
    return urls;
  }
  // 只获取最新的消息
  const lastMessage = messages[messages.length - 1];
  if (_.isArray(lastMessage.content)) {
    lastMessage.content.forEach((v) => {
      if (!_.isObject(v) || !["file", "image_url"].includes(v["type"])) return;
      // glm-free-api支持格式
      if (
        v["type"] == "file" &&
        _.isObject(v["file_url"]) &&
        _.isString(v["file_url"]["url"])
      )
        urls.push(v["file_url"]["url"]);
      // 兼容gpt-4-vision-preview API格式
      else if (
        v["type"] == "image_url" &&
        _.isObject(v["image_url"]) &&
        _.isString(v["image_url"]["url"])
      )
        urls.push(v["image_url"]["url"]);
    });
  }
  logger.info("本次请求上传：" + urls.length + "个文件");
  return urls;
}

/**
 * 消息预处理
 *
 * 由于接口只取第一条消息，此处会将多条消息合并为一条，实现多轮对话效果
 * user:旧消息1
 * assistant:旧消息2
 * user:新消息
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refs 参考文件列表
 * @param isRefConv 是否为引用会话
 */
function messagesPrepare(messages: any[], refs: any[] = [], isRefConv = false) {
  let content;
  if (isRefConv || messages.length < 2) {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return (
          message.content.reduce((_content, v) => {
            if (!_.isObject(v) || v["type"] != "text") return _content;
            return _content + (v["text"] || "") + "\n";
          }, content)
        );
      }
      return content + `${message.content}\n`;
    }, "");
    logger.info("\n透传内容：\n" + content);
  }
  else {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return message.content.reduce((_content, v) => {
          if (!_.isObject(v) || v["type"] != "text") return _content;
          return _content + `<|im_start|>${message.role || "user"}\n${v["text"] || ""}<|im_end|>\n`;
        }, content);
      }
      return (content += `<|im_start|>${message.role || "user"}\n${
        message.content
      }<|im_end|>\n`);
    }, "").replace(/\!\[.*\]\(.+\)/g, "");
    logger.info("\n对话合并：\n" + content);
  }
  return [
    {
      content,
      contentType: "text",
      role: "user",
    },
    ...refs
  ];
}

/**
 * 检查请求结果
 *
 * @param result 结果
 */
function checkResult(result: AxiosResponse) {
  if (!result.data) return null;
  const { success, errorCode, errorMsg } = result.data;
  if (!_.isBoolean(success) || success) return result.data;
  throw new APIException(
    EX.API_REQUEST_FAILED,
    `[请求qwen失败]: ${errorCode}-${errorMsg}`
  );
}

/**
 * 从流接收完整的消息内容
 *
 * @param stream 消息流
 */
async function receiveStream(stream: any): Promise<any> {
  return new Promise((resolve, reject) => {
    // 消息初始化
    const data = {
      id: "",
      model: MODEL_NAME,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        if (event.data == "[DONE]") return;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        if (!data.id && result.sessionId && result.msgId)
          data.id = `${result.sessionId}-${result.msgId}`;
        const text = (result.contents || []).reduce((str, part) => {
          const { contentType, role, content } = part;
          if (contentType != "text" && contentType != "text2image") return str;
          if (role != "assistant" && !_.isString(content)) return str;
          return str + content;
        }, "");
        const exceptCharIndex = text.indexOf("�");
        let chunk = text.substring(
          exceptCharIndex != -1
            ? Math.min(data.choices[0].message.content.length, exceptCharIndex)
            : data.choices[0].message.content.length,
          exceptCharIndex == -1 ? text.length : exceptCharIndex
        );
        if (chunk && result.contentType == "text2image") {
          chunk = chunk.replace(
            /https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=\,]*)/gi,
            (url) => {
              const urlObj = new URL(url);
              urlObj.search = "";
              return urlObj.toString();
            }
          );
        }
        if (result.msgStatus != "finished") {
          if (result.contentType == "text")
            data.choices[0].message.content += chunk;
        } else {
          data.choices[0].message.content += chunk;
          if (!result.canShare)
            data.choices[0].message.content +=
              "\n[内容由于不合规被停止生成，我们换个话题吧]";
          if (result.errorCode)
            data.choices[0].message.content += `服务暂时不可用，第三方响应错误：${result.errorCode}`;
          resolve(data);
        }
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve(data));
    stream.end();
  });
}

/**
 * 创建转换流
 *
 * 将流格式转换为gpt兼容流格式
 *
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createTransStream(stream: any, endCallback?: Function) {
  // 消息创建时间
  const created = util.unixTimestamp();
  // 创建转换流
  const transStream = new PassThrough();
  let content = "";
  !transStream.closed &&
    transStream.write(
      `data: ${JSON.stringify({
        id: "",
        model: MODEL_NAME,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`
    );
  const parser = createParser((event) => {
    try {
      if (event.type !== "event") return;
      if (event.data == "[DONE]") return;
      // 解析JSON
      const result = _.attempt(() => JSON.parse(event.data));
      if (_.isError(result))
        throw new Error(`Stream response invalid: ${event.data}`);
      const text = (result.contents || []).reduce((str, part) => {
        const { contentType, role, content } = part;
        if (contentType != "text" && contentType != "text2image") return str;
        if (role != "assistant" && !_.isString(content)) return str;
        return str + content;
      }, "");
      const exceptCharIndex = text.indexOf("�");
      let chunk = text.substring(
        exceptCharIndex != -1
          ? Math.min(content.length, exceptCharIndex)
          : content.length,
        exceptCharIndex == -1 ? text.length : exceptCharIndex
      );
      if (chunk && result.contentType == "text2image") {
        chunk = chunk.replace(
          /https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=\,]*)/gi,
          (url) => {
            const urlObj = new URL(url);
            urlObj.search = "";
            return urlObj.toString();
          }
        );
      }
      if (result.msgStatus != "finished") {
        if (chunk && result.contentType == "text") {
          content += chunk;
          const data = `data: ${JSON.stringify({
            id: `${result.sessionId}-${result.msgId}`,
            model: MODEL_NAME,
            object: "chat.completion.chunk",
            choices: [
              { index: 0, delta: { content: chunk }, finish_reason: null },
            ],
            created,
          })}\n\n`;
          !transStream.closed && transStream.write(data);
        }
      } else {
        const delta = { content: chunk || "" };
        if (!result.canShare)
          delta.content += "\n[内容由于不合规被停止生成，我们换个话题吧]";
        if (result.errorCode)
          delta.content += `服务暂时不可用，第三方响应错误：${result.errorCode}`;
        const data = `data: ${JSON.stringify({
          id: `${result.sessionId}-${result.msgId}`,
          model: MODEL_NAME,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta,
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        content = "";
        endCallback && endCallback(result.sessionId);
      }
      // else
      //   logger.warn(result.event, result);
    } catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end("\n\n");
    }
  });
  // 将流数据喂给SSE转换器
  stream.on("data", (buffer) => parser.feed(buffer.toString()));
  stream.once(
    "error",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.once(
    "close",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.end();
  return transStream;
}

/**
 * 从流接收图像
 *
 * @param stream 消息流
 */
async function receiveImages(
  stream: any
): Promise<{ convId: string; imageUrls: string[] }> {
  return new Promise((resolve, reject) => {
    let convId = "";
    const imageUrls = [];
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        if (event.data == "[DONE]") return;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        if (!convId && result.sessionId) convId = result.sessionId;
        const text = (result.contents || []).reduce((str, part) => {
          const { role, content } = part;
          if (role != "assistant" && !_.isString(content)) return str;
          return str + content;
        }, "");
        if (result.contentFrom == "text2image") {
          const urls =
            text.match(
              /https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=\,]*)/gi
            ) || [];
          urls.forEach((url) => {
            const urlObj = new URL(url);
            urlObj.search = "";
            const imageUrl = urlObj.toString();
            if (imageUrls.indexOf(imageUrl) != -1) return;
            imageUrls.push(imageUrl);
          });
        }
        if (result.msgStatus == "finished") {
          if (!result.canShare || imageUrls.length == 0)
            throw new APIException(EX.API_CONTENT_FILTERED);
          if (result.errorCode)
            throw new APIException(
              EX.API_REQUEST_FAILED,
              `服务暂时不可用，第三方响应错误：${result.errorCode}`
            );
        }
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve({ convId, imageUrls }));
    stream.end();
  });
}

/**
 * 获取上传参数
 *
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 */
async function acquireUploadParams(ticket: string) {
  const result = await axios.post(
    "https://qianwen.biz.aliyun.com/dialog/uploadToken",
    {},
    {
      timeout: 15000,
      headers: {
        Cookie: generateCookie(ticket),
        ...FAKE_HEADERS,
      },
      validateStatus: () => true,
    }
  );
  const { data } = checkResult(result);
  return data;
}

/**
 * 预检查文件URL有效性
 *
 * @param fileUrl 文件URL
 */
async function checkFileUrl(fileUrl: string) {
  if (util.isBASE64Data(fileUrl)) return;
  const result = await axios.head(fileUrl, {
    timeout: 15000,
    validateStatus: () => true,
  });
  if (result.status >= 400)
    throw new APIException(
      EX.API_FILE_URL_INVALID,
      `File ${fileUrl} is not valid: [${result.status}] ${result.statusText}`
    );
  // 检查文件大小
  if (result.headers && result.headers["content-length"]) {
    const fileSize = parseInt(result.headers["content-length"], 10);
    if (fileSize > FILE_MAX_SIZE)
      throw new APIException(
        EX.API_FILE_EXECEEDS_SIZE,
        `File ${fileUrl} is not valid`
      );
  }
}

/**
 * 上传文件
 *
 * @param fileUrl 文件URL
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 */
async function uploadFile(fileUrl: string, ticket: string) {
  // 预检查远程文件URL可用性
  await checkFileUrl(fileUrl);

  let filename, fileData, mimeType;
  // 如果是BASE64数据则直接转换为Buffer
  if (util.isBASE64Data(fileUrl)) {
    mimeType = util.extractBASE64DataFormat(fileUrl);
    const ext = mime.getExtension(mimeType);
    filename = `${util.uuid()}.${ext}`;
    fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), "base64");
  }
  // 下载文件到内存，如果您的服务器内存很小，建议考虑改造为流直传到下一个接口上，避免停留占用内存
  else {
    filename = path.basename(fileUrl);
    ({ data: fileData } = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      // 100M限制
      maxContentLength: FILE_MAX_SIZE,
      // 60秒超时
      timeout: 60000,
    }));
  }

  // 获取文件的MIME类型
  mimeType = mimeType || mime.getType(filename);

  // 获取上传参数
  const { accessId, policy, signature, dir } = await acquireUploadParams(
    ticket
  );

  const formData = new FormData();
  formData.append("OSSAccessKeyId", accessId);
  formData.append("policy", policy);
  formData.append("signature", signature);
  formData.append("key", `${dir}${filename}`);
  formData.append("dir", dir);
  formData.append("success_action_status", "200");
  formData.append("file", fileData, {
    filename,
    contentType: mimeType,
  });

  // 上传文件到OSS
  await axios.request({
    method: "POST",
    url: "https://broadscope-dialogue-new.oss-cn-beijing.aliyuncs.com/",
    data: formData,
    // 100M限制
    maxBodyLength: FILE_MAX_SIZE,
    // 60秒超时
    timeout: 120000,
    headers: {
      ...FAKE_HEADERS,
      "X-Requested-With": "XMLHttpRequest"
    }
  });

  const isImage = [
    'image/jpeg',
    'image/jpg',
    'image/tiff',
    'image/png',
    'image/bmp',
    'image/gif',
    'image/svg+xml', 
    'image/webp',
    'image/ico',
    'image/heic',
    'image/heif',
    'image/bmp',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'image/x-png'
  ].includes(mimeType);

  if(isImage) {
    const result = await axios.post(
      "https://qianwen.biz.aliyun.com/dialog/downloadLink",
      {
        fileKey: filename,
        fileType: "image",
        dir
      },
      {
        timeout: 15000,
        headers: {
          Cookie: generateCookie(ticket),
          ...FAKE_HEADERS,
        },
        validateStatus: () => true,
      }
    );
    const { data } = checkResult(result);
    return {
      role: "user",
      contentType: "image",
      content: data.url
    };
  }
  else {
    let result = await axios.post(
      "https://qianwen.biz.aliyun.com/dialog/downloadLink/batch",
      {
        fileKeys: [filename],
        fileType: "file",
        dir
      },
      {
        timeout: 15000,
        headers: {
          Cookie: generateCookie(ticket),
          ...FAKE_HEADERS,
        },
        validateStatus: () => true,
      }
    );
    const { data } = checkResult(result);
    if(!data.results[0] || !data.results[0].url)
      throw new Error(`文件上传失败：${data.results[0] ? data.results[0].errorMsg : '未知错误'}`);
    const url = data.results[0].url;
    const startTime = util.timestamp();
    while(true) {
      result = await axios.post(
        "https://qianwen.biz.aliyun.com/dialog/secResult/batch",
        {
          urls: [url]
        },
        {
          timeout: 15000,
          headers: {
            Cookie: generateCookie(ticket),
            ...FAKE_HEADERS,
          },
          validateStatus: () => true,
        }
      );
      const { data } = checkResult(result);
      if(data.pollEndFlag) {
        if(data.statusList[0] && data.statusList[0].status === 0)
          throw new Error(`文件处理失败：${data.statusList[0].errorMsg || '未知错误'}`);
        break;
      }
      if(util.timestamp() > startTime + 120000)
        throw new Error("文件处理超时：超出120秒");
    }
    return {
      role: "user",
      contentType: "file",
      content: url,
      ext: { fileSize: fileData.byteLength }
    };
  }
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
function tokenSplit(authorization: string) {
  return authorization.replace("Bearer ", "").split(",");
}

/**
 * 生成Cookies
 *
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 */
function generateCookie(ticket: string) {
  return [
    `${ticket.length > 100 ? 'login_aliyunid_ticket' : 'tongyi_sso_ticket'}=${ticket}`,
    'aliyun_choice=intl',
    "_samesite_flag_=true",
    `t=${util.uuid(false)}`,
    // `login_aliyunid_csrf=_csrf_tk_${util.generateRandomString({ charset: 'numeric', length: 15 })}`,
    // `cookie2=${util.uuid(false)}`,
    // `munb=22${util.generateRandomString({ charset: 'numeric', length: 11 })}`,
    // `csg=`,
    // `_tb_token_=${util.generateRandomString({ length: 10, capitalization: 'lowercase' })}`,
    // `cna=`,
    // `cnaui=`,
    // `atpsida=`,
    // `isg=`,
    // `tfstk=`,
    // `aui=`,
    // `sca=`
  ].join("; ");
}

/**
 * 获取Token存活状态
 */
async function getTokenLiveStatus(ticket: string) {
  const result = await axios.post(
    "https://qianwen.biz.aliyun.com/dialog/session/list",
    {},
    {
      headers: {
        Cookie: generateCookie(ticket),
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  try {
    const { data } = checkResult(result);
    return _.isArray(data);
  }
  catch(err) {
    return false;
  }
}

/**
 * 法律咨询对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 * @param refConvId 引用的会话ID
 * @param retryCount 重试次数
 */
async function createLawCompletion(
  model = LAW_MODEL_NAME,
  messages: any[],
  ticket: string,
  refConvId = '',
  retryCount = 0
) {
  let session: http2.ClientHttp2Session;
  return (async () => {
    logger.info("法律咨询请求:", messages);

    // 提取引用文件URL并上传qwen获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, ticket))
        )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z]{32}/.test(refConvId))
      refConvId = '';

    // 请求流 - 使用法律咨询专用的API端点
    const session: http2.ClientHttp2Session = await new Promise(
      (resolve, reject) => {
        const session = http2.connect("https://api.tongyi.com");
        session.on("connect", () => resolve(session));
        session.on("error", reject);
      }
    );
    const [sessionId, parentMsgId = ''] = refConvId.split('-');
    const req = session.request({
      ":method": "POST",
      ":path": "/dialog/conversation",
      "Content-Type": "application/json",
      Cookie: generateCookie(ticket),
      ...FAKE_HEADERS,
      Accept: "text/event-stream",
      // 法律咨询专用headers
      Origin: "https://www.tongyi.com",
      Referer: "https://www.tongyi.com/discover/chat?agentId=A-0002-C0000001",
    });
    req.setTimeout(120000);
    req.write(
      JSON.stringify({
        params: {
          "0": "r",
          "1": "i",
          "2": "g",
          "3": "h",
          "4": "t",
          agentId: "A-0002-C0000001",
          searchType: "",
          pptGenerate: false,
          bizScene: "",
          bizSceneInfo: {},
          specifiedModel: "",
          deepThink: false,
          deepResearch: false
        },
        model: "",
        action: "next",
        mode: "chat",
        userAction: "chat",
        requestId: util.uuid(false),
        sessionId,
        sessionType: "text_chat",
        parentMsgId,
        contents: prepareLawMessages(messages, refs, !!refConvId),
      })
    );
    req.end();
    req.setEncoding("utf8");
    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveLawStream(req);
    session.close();
    logger.success(
      `Law consultation stream completed ${util.timestamp() - streamStartTime}ms`
    );

    // 异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
    removeConversation(answer.id, ticket).catch((err) => console.error(err));

    return answer;
  })().catch((err) => {
    session && session.close();
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Law consultation stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createLawCompletion(model, messages, ticket, refConvId, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 流式法律咨询对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 * @param refConvId 引用的会话ID
 * @param retryCount 重试次数
 */
async function createLawCompletionStream(
  model = LAW_MODEL_NAME,
  messages: any[],
  ticket: string,
  refConvId = '',
  retryCount = 0
) {
  let session: http2.ClientHttp2Session;
  return (async () => {
    logger.info("法律咨询流式请求:", messages);

    // 提取引用文件URL并上传qwen获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, ticket))
        )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z]{32}/.test(refConvId))
      refConvId = ''

    // 请求流 - 使用法律咨询专用的API端点
    session = await new Promise((resolve, reject) => {
      const session = http2.connect("https://api.tongyi.com");
      session.on("connect", () => resolve(session));
      session.on("error", reject);
    });
    const [sessionId, parentMsgId = ''] = refConvId.split('-');
    const req = session.request({
      ":method": "POST",
      ":path": "/dialog/conversation",
      "Content-Type": "application/json",
      Cookie: generateCookie(ticket),
      ...FAKE_HEADERS,
      Accept: "text/event-stream",
      // 法律咨询专用headers
      Origin: "https://www.tongyi.com",
      Referer: "https://www.tongyi.com/discover/chat?agentId=A-0002-C0000001",
    });
    req.setTimeout(120000);
    req.write(
      JSON.stringify({
        params: {
          "0": "r",
          "1": "i",
          "2": "g",
          "3": "h",
          "4": "t",
          agentId: "A-0002-C0000001",
          searchType: "",
          pptGenerate: false,
          bizScene: "",
          bizSceneInfo: {},
          specifiedModel: "",
          deepThink: false,
          deepResearch: false
        },
        model: "",
        action: "next",
        mode: "chat",
        userAction: "chat",
        requestId: util.uuid(false),
        sessionId,
        sessionType: "text_chat",
        parentMsgId,
        contents: prepareLawMessages(messages, refs, !!refConvId),
      })
    );
    req.end();
    req.setEncoding("utf8");
    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createLawTransStream(req, (convId: string) => {
      // 关闭请求会话
      session.close();
      logger.success(
        `Law consultation stream completed ${util.timestamp() - streamStartTime}ms`
      );
      // 流传输结束后异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
      removeConversation(convId, ticket).catch((err) => console.error(err));
    });
  })().catch((err) => {
    session && session.close();
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Law consultation stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createLawCompletionStream(model, messages, ticket, refConvId, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 法律咨询消息预处理
 *
 * 专门为法律咨询场景优化的消息格式处理
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refs 参考文件列表
 * @param isRefConv 是否为引用会话
 */
function prepareLawMessages(messages: any[], refs: any[] = [], isRefConv = false) {
  let content;
  if (isRefConv || messages.length < 2) {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return (
          message.content.reduce((_content, v) => {
            if (!_.isObject(v) || v["type"] != "text") return _content;
            return _content + (v["text"] || "") + "\n";
          }, content)
        );
      }
      return content + `${message.content}\n`;
    }, "");
    logger.info("\n法律咨询透传内容：\n" + content);
  }
  else {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return message.content.reduce((_content, v) => {
          if (!_.isObject(v) || v["type"] != "text") return _content;
          return _content + `<|im_start|>${message.role || "user"}\n${v["text"] || ""}<|im_end|>\n`;
        }, content);
      }
      return (content += `<|im_start|>${message.role || "user"}\n${
        message.content
      }<|im_end|>\n`);
    }, "").replace(/\!\[.*\]\(.+\)/g, "");
    logger.info("\n法律咨询对话合并：\n" + content);
  }
  return [
    {
      content,
      contentType: "text",
      role: "user",
      ext: {
        searchType: "",
        pptGenerate: false,
        deepThink: false,
        deepResearch: false
      }
    },
    ...refs
  ];
}

/**
 * 从流接收完整的法律咨询消息内容
 *
 * @param stream 消息流
 */
async function receiveLawStream(stream: any): Promise<any> {
  return new Promise((resolve, reject) => {
    // 消息初始化
    const data = {
      id: "",
      model: LAW_MODEL_NAME,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        if (event.data == "[DONE]") return;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        if (!data.id && result.sessionId && result.msgId)
          data.id = `${result.sessionId}-${result.msgId}`;
        const text = (result.contents || []).reduce((str, part) => {
          const { contentType, role, content } = part;
          if (contentType != "text" && contentType != "text2image") return str;
          if (role != "assistant" && !_.isString(content)) return str;
          return str + content;
        }, "");
        const exceptCharIndex = text.indexOf("�");
        let chunk = text.substring(
          exceptCharIndex != -1
            ? Math.min(data.choices[0].message.content.length, exceptCharIndex)
            : data.choices[0].message.content.length,
          exceptCharIndex == -1 ? text.length : exceptCharIndex
        );
        if (chunk && result.contentType == "text2image") {
          chunk = chunk.replace(
            /https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=\,]*)/gi,
            (url) => {
              const urlObj = new URL(url);
              urlObj.search = "";
              return urlObj.toString();
            }
          );
        }
        if (result.msgStatus != "finished") {
          // 对于法律咨询，在生成过程中累积内容
          if (result.contentType == "text" || !result.contentType)
            data.choices[0].message.content += chunk;
        } else {
          // 当消息完成时，如果是incremental=false，说明contents包含完整内容
          if (result.incremental === false && result.contents && result.contents.length > 0) {
            // 提取完整的最终内容
            const finalContent = result.contents.reduce((str, part) => {
              if (part.role === "assistant" && part.contentType === "text" && part.status === "finished") {
                return str + (part.content || "");
              }
              return str;
            }, "");
            data.choices[0].message.content = finalContent;
          } else {
            // 否则继续累积chunk
            data.choices[0].message.content += chunk;
          }

          if (!result.canShare)
            data.choices[0].message.content +=
              "\n[内容由于不合规被停止生成，我们换个话题吧]";
          if (result.errorCode)
            data.choices[0].message.content += `服务暂时不可用，第三方响应错误：${result.errorCode}`;
          resolve(data);
        }
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve(data));
    stream.end();
  });
}

/**
 * 创建法律咨询转换流
 *
 * 将流格式转换为gpt兼容流格式
 *
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createLawTransStream(stream: any, endCallback?: Function) {
  // 消息创建时间
  const created = util.unixTimestamp();
  // 创建转换流
  const transStream = new PassThrough();
  let content = "";
  !transStream.closed &&
    transStream.write(
      `data: ${JSON.stringify({
        id: "",
        model: LAW_MODEL_NAME,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`
    );
  const parser = createParser((event) => {
    try {
      if (event.type !== "event") return;
      if (event.data == "[DONE]") return;
      // 解析JSON
      const result = _.attempt(() => JSON.parse(event.data));
      if (_.isError(result))
        throw new Error(`Stream response invalid: ${event.data}`);
      const text = (result.contents || []).reduce((str, part) => {
        const { contentType, role, content } = part;
        if (contentType != "text" && contentType != "text2image") return str;
        if (role != "assistant" && !_.isString(content)) return str;
        return str + content;
      }, "");
      const exceptCharIndex = text.indexOf("�");
      let chunk = text.substring(
        exceptCharIndex != -1
          ? Math.min(content.length, exceptCharIndex)
          : content.length,
        exceptCharIndex == -1 ? text.length : exceptCharIndex
      );
      if (chunk && result.contentType == "text2image") {
        chunk = chunk.replace(
          /https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=\,]*)/gi,
          (url) => {
            const urlObj = new URL(url);
            urlObj.search = "";
            return urlObj.toString();
          }
        );
      }
      if (result.msgStatus != "finished") {
        if (chunk && result.contentType == "text") {
          content += chunk;
          const data = `data: ${JSON.stringify({
            id: `${result.sessionId}-${result.msgId}`,
            model: LAW_MODEL_NAME,
            object: "chat.completion.chunk",
            choices: [
              { index: 0, delta: { content: chunk }, finish_reason: null },
            ],
            created,
          })}\n\n`;
          !transStream.closed && transStream.write(data);
        }
      } else {
        const delta = { content: chunk || "" };
        if (!result.canShare)
          delta.content += "\n[内容由于不合规被停止生成，我们换个话题吧]";
        if (result.errorCode)
          delta.content += `服务暂时不可用，第三方响应错误：${result.errorCode}`;
        const data = `data: ${JSON.stringify({
          id: `${result.sessionId}-${result.msgId}`,
          model: LAW_MODEL_NAME,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta,
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        content = "";
        endCallback && endCallback(result.sessionId);
      }
    } catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end("\n\n");
    }
  });
  // 将流数据喂给SSE转换器
  stream.on("data", (buffer) => parser.feed(buffer.toString()));
  stream.once(
    "error",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.once(
    "close",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.end();
  return transStream;
}

/**
 * 解题对话补全（纯文本）
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 * @param refConvId 引用的会话ID
 * @param retryCount 重试次数
 */
async function createSolveCompletion(
  model = SOLVE_TXT_MODEL_NAME,
  messages: any[],
  ticket: string,
  refConvId = '',
  retryCount = 0
) {
  let session: http2.ClientHttp2Session;
  return (async () => {
    logger.info("解题请求:", messages);

    // 提取引用文件URL并上传qwen获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, ticket))
        )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z]{32}/.test(refConvId))
      refConvId = '';

    // 请求流 - 使用解题专用的API端点
    const session: http2.ClientHttp2Session = await new Promise(
      (resolve, reject) => {
        const session = http2.connect("https://api.tongyi.com");
        session.on("connect", () => resolve(session));
        session.on("error", reject);
      }
    );
    const [sessionId, parentMsgId = ''] = refConvId.split('-');
    const req = session.request({
      ":method": "POST",
      ":path": "/dialog/conversation",
      "Content-Type": "application/json",
      Cookie: generateCookie(ticket),
      ...FAKE_HEADERS,
      Accept: "text/event-stream",
      // 解题专用headers
      Origin: "https://www.tongyi.com",
      Referer: "https://www.tongyi.com/discover/chat?agentId=A-B70463-a3e151d8",
    });
    req.setTimeout(120000);
    req.write(
      JSON.stringify({
        model: "",
        action: "next",
        mode: "chat",
        userAction: "chat",
        requestId: util.uuid(false),
        sessionId,
        sessionType: "text_chat",
        parentMsgId,
        params: {
          agentId: "A-B70463-a3e151d8",
          searchType: "",
          pptGenerate: false,
          bizScene: "",
          bizSceneInfo: {},
          specifiedModel: "",
          deepThink: false,
          deepResearch: false
        },
        contents: prepareSolveMessages(messages, refs, !!refConvId),
      })
    );
    req.end();
    req.setEncoding("utf8");
    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const answer = await receiveSolveStream(req, model);
    session.close();
    logger.success(
      `Solve completion stream completed ${util.timestamp() - streamStartTime}ms`
    );

    // 异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
    removeConversation(answer.id, ticket).catch((err) => console.error(err));

    return answer;
  })().catch((err) => {
    session && session.close();
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Solve completion stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createSolveCompletion(model, messages, ticket, refConvId, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 流式解题对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 * @param refConvId 引用的会话ID
 * @param retryCount 重试次数
 */
async function createSolveCompletionStream(
  model = SOLVE_TXT_MODEL_NAME,
  messages: any[],
  ticket: string,
  refConvId = '',
  retryCount = 0
) {
  let session: http2.ClientHttp2Session;
  return (async () => {
    logger.info("解题流式请求:", messages);

    // 提取引用文件URL并上传qwen获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, ticket))
        )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z]{32}/.test(refConvId))
      refConvId = ''

    // 请求流 - 使用解题专用的API端点
    session = await new Promise((resolve, reject) => {
      const session = http2.connect("https://api.tongyi.com");
      session.on("connect", () => resolve(session));
      session.on("error", reject);
    });
    const [sessionId, parentMsgId = ''] = refConvId.split('-');
    const req = session.request({
      ":method": "POST",
      ":path": "/dialog/conversation",
      "Content-Type": "application/json",
      Cookie: generateCookie(ticket),
      ...FAKE_HEADERS,
      Accept: "text/event-stream",
      // 解题专用headers
      Origin: "https://www.tongyi.com",
      Referer: "https://www.tongyi.com/discover/chat?agentId=A-B70463-a3e151d8",
    });
    req.setTimeout(120000);
    req.write(
      JSON.stringify({
        model: "",
        action: "next",
        mode: "chat",
        userAction: "chat",
        requestId: util.uuid(false),
        sessionId,
        sessionType: "text_chat",
        parentMsgId,
        params: {
          agentId: "A-B70463-a3e151d8",
          searchType: "",
          pptGenerate: false,
          bizScene: "",
          bizSceneInfo: {},
          specifiedModel: "",
          deepThink: false,
          deepResearch: false
        },
        contents: prepareSolveMessages(messages, refs, !!refConvId),
      })
    );
    req.end();
    req.setEncoding("utf8");
    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    return createSolveTransStream(req, model, (convId: string) => {
      // 关闭请求会话
      session.close();
      logger.success(
        `Solve completion stream completed ${util.timestamp() - streamStartTime}ms`
      );
      // 流传输结束后异步移除会话，如果消息不合规，此操作可能会抛出数据库错误异常，请忽略
      removeConversation(convId, ticket).catch((err) => console.error(err));
    });
  })().catch((err) => {
    session && session.close();
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Solve completion stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createSolveCompletionStream(model, messages, ticket, refConvId, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 解题消息预处理
 *
 * 专门为解题场景优化的消息格式处理
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refs 参考文件列表
 * @param isRefConv 是否为引用会话
 */
function prepareSolveMessages(messages: any[], refs: any[] = [], isRefConv = false) {
  let content;
  if (isRefConv || messages.length < 2) {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return (
          message.content.reduce((_content, v) => {
            if (!_.isObject(v) || v["type"] != "text") return _content;
            return _content + (v["text"] || "") + "\n";
          }, content)
        );
      }
      return content + `${message.content}\n`;
    }, "");
    logger.info("\n解题透传内容：\n" + content);
  }
  else {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return message.content.reduce((_content, v) => {
          if (!_.isObject(v) || v["type"] != "text") return _content;
          return _content + `<|im_start|>${message.role || "user"}\n${v["text"] || ""}<|im_end|>\n`;
        }, content);
      }
      return (content += `<|im_start|>${message.role || "user"}\n${
        message.content
      }<|im_end|>\n`);
    }, "").replace(/\!\[.*\]\(.+\)/g, "");
    logger.info("\n解题对话合并：\n" + content);
  }
  return [
    {
      content,
      contentType: "text",
      role: "user",
      ext: {
        searchType: "",
        pptGenerate: false,
        deepThink: false,
        deepResearch: false
      }
    },
    ...refs
  ];
}

/**
 * 从流接收完整的解题消息内容
 *
 * @param stream 消息流
 * @param model 模型名称
 */
async function receiveSolveStream(stream: any, model: string): Promise<any> {
  return new Promise((resolve, reject) => {
    // 消息初始化
    const data = {
      id: "",
      model: model,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
    };
    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        if (event.data == "[DONE]") return;
        // 解析JSON
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`Stream response invalid: ${event.data}`);
        if (!data.id && result.sessionId && result.msgId)
          data.id = `${result.sessionId}-${result.msgId}`;
        const text = (result.contents || []).reduce((str, part) => {
          const { contentType, role, content } = part;
          if (contentType != "text" && contentType != "text2image") return str;
          if (role != "assistant" && !_.isString(content)) return str;
          return str + content;
        }, "");
        const exceptCharIndex = text.indexOf("�");
        let chunk = text.substring(
          exceptCharIndex != -1
            ? Math.min(data.choices[0].message.content.length, exceptCharIndex)
            : data.choices[0].message.content.length,
          exceptCharIndex == -1 ? text.length : exceptCharIndex
        );
        if (chunk && result.contentType == "text2image") {
          chunk = chunk.replace(
            /https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=\,]*)/gi,
            (url) => {
              const urlObj = new URL(url);
              urlObj.search = "";
              return urlObj.toString();
            }
          );
        }
        if (result.msgStatus != "finished") {
          // 对于解题，在生成过程中累积内容
          if (result.contentType == "text" || !result.contentType)
            data.choices[0].message.content += chunk;
        } else {
          // 当消息完成时，如果是incremental=false，说明contents包含完整内容
          if (result.incremental === false && result.contents && result.contents.length > 0) {
            // 提取完整的最终内容
            const finalContent = result.contents.reduce((str, part) => {
              if (part.role === "assistant" && part.contentType === "text" && part.status === "finished") {
                return str + (part.content || "");
              }
              return str;
            }, "");
            data.choices[0].message.content = finalContent;
          } else {
            // 否则继续累积chunk
            data.choices[0].message.content += chunk;
          }

          if (!result.canShare)
            data.choices[0].message.content +=
              "\n[内容由于不合规被停止生成，我们换个话题吧]";
          if (result.errorCode)
            data.choices[0].message.content += `服务暂时不可用，第三方响应错误：${result.errorCode}`;
          resolve(data);
        }
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => resolve(data));
    stream.end();
  });
}

/**
 * 创建解题转换流
 *
 * 将流格式转换为gpt兼容流格式
 *
 * @param stream 消息流
 * @param model 模型名称
 * @param endCallback 传输结束回调
 */
function createSolveTransStream(stream: any, model: string, endCallback?: Function) {
  // 消息创建时间
  const created = util.unixTimestamp();
  // 创建转换流
  const transStream = new PassThrough();
  let content = "";
  !transStream.closed &&
    transStream.write(
      `data: ${JSON.stringify({
        id: "",
        model: model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`
    );
  const parser = createParser((event) => {
    try {
      if (event.type !== "event") return;
      if (event.data == "[DONE]") return;
      // 解析JSON
      const result = _.attempt(() => JSON.parse(event.data));
      if (_.isError(result))
        throw new Error(`Stream response invalid: ${event.data}`);
      const text = (result.contents || []).reduce((str, part) => {
        const { contentType, role, content } = part;
        if (contentType != "text" && contentType != "text2image") return str;
        if (role != "assistant" && !_.isString(content)) return str;
        return str + content;
      }, "");
      const exceptCharIndex = text.indexOf("�");
      let chunk = text.substring(
        exceptCharIndex != -1
          ? Math.min(content.length, exceptCharIndex)
          : content.length,
        exceptCharIndex == -1 ? text.length : exceptCharIndex
      );
      if (chunk && result.contentType == "text2image") {
        chunk = chunk.replace(
          /https?:\/\/[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=\,]*)/gi,
          (url) => {
            const urlObj = new URL(url);
            urlObj.search = "";
            return urlObj.toString();
          }
        );
      }
      if (result.msgStatus != "finished") {
        if (chunk && result.contentType == "text") {
          content += chunk;
          const data = `data: ${JSON.stringify({
            id: `${result.sessionId}-${result.msgId}`,
            model: model,
            object: "chat.completion.chunk",
            choices: [
              { index: 0, delta: { content: chunk }, finish_reason: null },
            ],
            created,
          })}\n\n`;
          !transStream.closed && transStream.write(data);
        }
      } else {
        const delta = { content: chunk || "" };
        if (!result.canShare)
          delta.content += "\n[内容由于不合规被停止生成，我们换个话题吧]";
        if (result.errorCode)
          delta.content += `服务暂时不可用，第三方响应错误：${result.errorCode}`;
        const data = `data: ${JSON.stringify({
          id: `${result.sessionId}-${result.msgId}`,
          model: model,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta,
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created,
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        !transStream.closed && transStream.end("data: [DONE]\n\n");
        content = "";
        endCallback && endCallback(result.sessionId);
      }
    } catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end("\n\n");
    }
  });
  // 将流数据喂给SSE转换器
  stream.on("data", (buffer) => parser.feed(buffer.toString()));
  stream.once(
    "error",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.once(
    "close",
    () => !transStream.closed && transStream.end("data: [DONE]\n\n")
  );
  stream.end();
  return transStream;
}

/**
 * 数字人消息预处理
 *
 * 专门为数字人视频生成场景优化的消息格式处理
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refs 参考文件列表
 * @param isRefConv 是否为引用会话
 */
function prepareDigitalPeopleMessages(messages: any[], refs: any[] = [], isRefConv = false) {
  let content;
  if (isRefConv || messages.length < 2) {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return (
          message.content.reduce((_content, v) => {
            if (!_.isObject(v) || v["type"] != "text") return _content;
            return _content + (v["text"] || "") + "\n";
          }, content)
        );
      }
      return content + `${message.content}\n`;
    }, "");
    logger.info("\n数字人透传内容：\n" + content);
  }
  else {
    content = messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return message.content.reduce((_content, v) => {
          if (!_.isObject(v) || v["type"] != "text") return _content;
          return _content + `<|im_start|>${message.role || "user"}\n${v["text"] || ""}<|im_end|>\n`;
        }, content);
      }
      return (content += `<|im_start|>${message.role || "user"}\n${
        message.content
      }<|im_end|>\n`);
    }, "").replace(/\!\[.*\]\(.+\)/g, "");
    logger.info("\n数字人对话合并：\n" + content);
  }
  return [
    {
      content,
      contentType: "text",
      role: "user",
      ext: {
        searchType: "",
        pptGenerate: false,
        deepThink: false,
        deepResearch: false
      }
    },
    ...refs
  ];
}

/**
 * 接收数字人第一步响应，获取cardCode、msgId、sessionId
 *
 * @param stream 消息流
 */
async function receiveDigitalPeopleFirstStep(stream: any): Promise<{cardCode: string, msgId: string, sessionId: string}> {
  return new Promise((resolve, reject) => {
    let result = {
      cardCode: "",
      msgId: "",
      sessionId: ""
    };

    const parser = createParser((event) => {
      try {
        if (event.type !== "event") return;
        if (event.data == "[DONE]") return;

        // Log the raw event data
        logger.info(`[DigitalPeopleFirstStep] Received stream data: ${event.data}`);

        // 解析JSON
        const data = _.attempt(() => JSON.parse(event.data));
        if (_.isError(data)) {
          logger.warn(`Stream response invalid, ignoring: ${event.data}`);
          return;
        }

        // 检查是否有API错误
        if (data.errorCode === 'AGENT_PRIVATE_ONLY') {
          throw new APIException(EX.API_REQUEST_FAILED, `[数字人Agent访问失败]: ${data.errorMsg} (errorCode: ${data.errorCode})。请检查配置文件中的 digital_people_agent_id 是否正确，以及提供的 token 是否有权访问该 Agent。`);
        }

        // 获取基本信息
        if (data.sessionId && !result.sessionId) {
          result.sessionId = data.sessionId;
        }
        if (data.msgId && !result.msgId) {
          result.msgId = data.msgId;
        }

        // 查找cardCode
        if (data.contents && Array.isArray(data.contents)) {
          for (const content of data.contents) {
            if (content.role === "workflow" && content.contentType === "card" && content.cardCode) {
              result.cardCode = content.cardCode;
            }
          }
        }
      } catch (err) {
        logger.error(`Error parsing stream data: ${err}`);
      }
    });

    // 将流数据喂给SSE转换器
    stream.on("data", (buffer) => parser.feed(buffer.toString()));
    stream.once("error", (err) => reject(err));
    stream.once("close", () => {
      // Log the final result before checking
      logger.info(`[DigitalPeopleFirstStep] Stream closed. Final extracted info: ${JSON.stringify(result)}`);
      if (result.cardCode && result.msgId && result.sessionId) {
        resolve(result);
      } else {
        reject(new Error("Failed to get required information from digital people first step"));
      }
    });
  });
}

/**
 * 轮询数字人任务状态直到完成
 *
 * @param taskId 任务ID
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 */
async function pollDigitalPeopleTask(taskId: string, ticket: string): Promise<{videoUrl: string, poster?: string}> {
  const maxAttempts = 180; // 最多轮询120次，每次间隔2秒，总共6分钟
  const pollInterval = 2000; // 2秒间隔
  const initialDelay = 60000; // 初始延迟60秒再开始轮询

  logger.info(`数字人任务提交成功，等待${initialDelay/1000}秒后开始轮询状态...`);
  await new Promise(resolve => setTimeout(resolve, initialDelay));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      logger.info(`开始第${attempt + 1}次轮询任务状态...`);

      const result = await axios.post(
        "https://api.tongyi.com/dialog/creative/task/get?from=qianwen_saas&header=%7B%22X-Platform%22%3A%22app%22%7D",
        {
          taskIds: [taskId]
        },
        {
          headers: {
            Cookie: generateCookie(ticket),
            ...FAKE_HEADERS,
            Accept: "application/json, text/plain, */*",
            Origin: "https://www.tongyi.com",
            Referer: `https://www.tongyi.com/discover/chat?agentId=${serviceConfig.digital_people_agent_id}`,
          },
          timeout: 30000,
          validateStatus: () => true,
        }
      );

      const taskData = checkResult(result);
      if (!taskData.data || !Array.isArray(taskData.data) || taskData.data.length === 0) {
        throw new Error("Invalid task polling response");
      }

      const task = taskData.data[0];
      logger.info(`数字人任务状态: ${task.status}, 当前步骤: ${task.step?.currentStep || 'unknown'}, 轮询次数: ${attempt + 1}/${maxAttempts}`);

      // status: 1=进行中, 2=完成, 0=失败
      if (task.status === 2) {
        // 任务完成，获取视频URL
        if (task.videos && task.videos.length > 0) {
          logger.success(`数字人视频生成完成！视频URL: ${task.videos[0].url}`);
          return {
            videoUrl: task.videos[0].url,
            poster: task.videos[0].poster
          };
        } else {
          throw new Error("Task completed but no video found");
        }
      } else if (task.status === 0) {
        // 任务失败
        throw new Error(`Digital people task failed: ${task.statusMessage || 'Unknown error'}`);
      }

      // 任务仍在进行中，等待后继续轮询
      if (attempt < maxAttempts - 1) {
        logger.info(`任务仍在进行中，等待${pollInterval/1000}秒后继续轮询...`);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

    } catch (err) {
      logger.error(`轮询第${attempt + 1}次失败: ${err.message}`);
      if (attempt === maxAttempts - 1) {
        throw new Error(`数字人任务轮询失败，已重试${maxAttempts}次: ${err.message}`);
      }
      logger.warn(`等待${pollInterval/1000}秒后重试...`);
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  throw new Error(`Digital people task timeout: exceeded maximum polling time (${maxAttempts * pollInterval / 1000 / 60} minutes)`);
}

/**
 * 数字人视频生成对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 * @param refConvId 引用的会话ID
 * @param retryCount 重试次数
 */
async function createDigitalPeopleCompletion(
  model = DIGITAL_PEOPLE_MODEL_NAME,
  messages: any[],
  ticket: string,
  refConvId = '',
  retryCount = 0
) {
  let session: http2.ClientHttp2Session;
  return (async () => {
    logger.info("数字人视频生成请求:", messages);

    // 提取引用文件URL并上传qwen获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, ticket))
        )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z]{32}/.test(refConvId))
      refConvId = '';

    // 第一步：发起数字人对话请求
    const session: http2.ClientHttp2Session = await new Promise(
      (resolve, reject) => {
        const session = http2.connect("https://api.tongyi.com");
        session.on("connect", () => resolve(session));
        session.on("error", reject);
      }
    );
    const [sessionId, parentMsgId = ''] = refConvId.split('-');
    const req = session.request({
      ":method": "POST",
      ":path": "/dialog/conversation",
      "Content-Type": "application/json",
      Cookie: generateCookie(ticket),
      ...FAKE_HEADERS,
      Accept: "text/event-stream",
      // 数字人专用headers
      Origin: "https://www.tongyi.com",
      Referer: `https://www.tongyi.com/discover/chat?agentId=${serviceConfig.digital_people_agent_id}`,
    });
    req.setTimeout(120000);
    req.write(
      JSON.stringify({
        model: "",
        action: "next",
        mode: "chat",
        userAction: "chat",
        requestId: util.uuid(false),
        sessionId,
        sessionType: "text_chat",
        parentMsgId,
        params: {
          agentId: serviceConfig.digital_people_agent_id,
          searchType: "",
          pptGenerate: false,
          bizScene: "",
          bizSceneInfo: {},
          specifiedModel: "",
          deepThink: false,
          deepResearch: false
        },
        contents: prepareDigitalPeopleMessages(messages, refs, !!refConvId),
      })
    );
    req.end();
    req.setEncoding("utf8");
    const streamStartTime = util.timestamp();

    // 接收第一步响应，获取cardCode、msgId、sessionId
    const firstStepResult = await receiveDigitalPeopleFirstStep(req);
    session.close();

    logger.success(
      `Digital people first step completed ${util.timestamp() - streamStartTime}ms`
    );

    // 第二步：提交任务获取taskId
    const taskSubmitResult = await axios.post(
      "https://api.tongyi.com/dialog/workflow/task/submit",
      {
        agentId: serviceConfig.digital_people_agent_id,
        cardCode: firstStepResult.cardCode,
        msgId: firstStepResult.msgId,
        sessionId: firstStepResult.sessionId,
        operationType: "create",
        taskParam: {}
      },
      {
        headers: {
          Cookie: generateCookie(ticket),
          ...FAKE_HEADERS,
          Accept: "application/json, text/plain, */*",
          Origin: "https://www.tongyi.com",
          Referer: `https://www.tongyi.com/discover/chat?agentId=${serviceConfig.digital_people_agent_id}`,
        },
        timeout: 30000,
        validateStatus: () => true,
      }
    );

    const taskSubmitData = checkResult(taskSubmitResult);
    if (!taskSubmitData.data || !taskSubmitData.data.contents || !taskSubmitData.data.contents[0]) {
      throw new Error("Failed to submit digital people task");
    }

    const taskContent = JSON.parse(taskSubmitData.data.contents[0].content);
    const taskId = taskContent.taskId;

    logger.info("数字人任务ID:", taskId);

    // 第三步：轮询任务状态直到完成
    logger.info(`开始轮询数字人任务状态，任务ID: ${taskId}`);
    const videoResult = await pollDigitalPeopleTask(taskId, ticket);
    logger.success(`数字人视频生成成功完成！耗时: ${util.timestamp() - streamStartTime}ms`);

    // 异步移除会话
    removeConversation(firstStepResult.sessionId, ticket).catch((err) => console.error(err));

    return {
      id: firstStepResult.sessionId + "-" + firstStepResult.msgId,
      model: DIGITAL_PEOPLE_MODEL_NAME,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: `数字人视频生成完成！\n\n视频地址：${videoResult.videoUrl}\n封面图片：${videoResult.poster || ''}`
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: util.unixTimestamp(),
      video_url: videoResult.videoUrl,
      poster: videoResult.poster
    };

  })().catch((err) => {
    session && session.close();
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Digital people completion error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createDigitalPeopleCompletion(model, messages, ticket, refConvId, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 流式数字人视频生成对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param ticket tongyi_sso_ticket或login_aliyunid_ticket
 * @param refConvId 引用的会话ID
 * @param retryCount 重试次数
 */
async function createDigitalPeopleCompletionStream(
  model = DIGITAL_PEOPLE_MODEL_NAME,
  messages: any[],
  ticket: string,
  refConvId = '',
  retryCount = 0
) {
  let session: http2.ClientHttp2Session;
  return (async () => {
    logger.info("数字人视频生成流式请求:", messages);

    // 提取引用文件URL并上传qwen获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(messages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, ticket))
        )
      : [];

    // 如果引用对话ID不正确则重置引用
    if (!/[0-9a-z]{32}/.test(refConvId))
      refConvId = ''

    // 创建转换流
    const transStream = new PassThrough();
    const created = util.unixTimestamp();

    // 发送初始响应
    !transStream.closed &&
      transStream.write(
        `data: ${JSON.stringify({
          id: "",
          model: DIGITAL_PEOPLE_MODEL_NAME,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "" },
              finish_reason: null,
            },
          ],
          created,
        })}\n\n`
      );

    // 异步处理数字人视频生成
    (async () => {
      try {
        // 发送进度更新
        const sendProgress = (content: string) => {
          if (!transStream.closed) {
            transStream.write(
              `data: ${JSON.stringify({
                id: util.uuid(false),
                model: DIGITAL_PEOPLE_MODEL_NAME,
                object: "chat.completion.chunk",
                choices: [
                  { index: 0, delta: { content }, finish_reason: null },
                ],
                created,
              })}\n\n`
            );
          }
        };

        sendProgress("正在启动数字人视频生成...\n");

        // 第一步：发起数字人对话请求
        const session: http2.ClientHttp2Session = await new Promise(
          (resolve, reject) => {
            const session = http2.connect("https://api.tongyi.com");
            session.on("connect", () => resolve(session));
            session.on("error", reject);
          }
        );
        const [sessionId, parentMsgId = ''] = refConvId.split('-');
        const req = session.request({
          ":method": "POST",
          ":path": "/dialog/conversation",
          "Content-Type": "application/json",
          Cookie: generateCookie(ticket),
          ...FAKE_HEADERS,
          Accept: "text/event-stream",
          Origin: "https://www.tongyi.com",
          Referer: `https://www.tongyi.com/discover/chat?agentId=${serviceConfig.digital_people_agent_id}`,
        });
        req.setTimeout(120000);
        req.write(
          JSON.stringify({
            model: "",
            action: "next",
            mode: "chat",
            userAction: "chat",
            requestId: util.uuid(false),
            sessionId,
            sessionType: "text_chat",
            parentMsgId,
            params: {
              agentId: serviceConfig.digital_people_agent_id,
              searchType: "",
              pptGenerate: false,
              bizScene: "",
              bizSceneInfo: {},
              specifiedModel: "",
              deepThink: false,
              deepResearch: false
            },
            contents: prepareDigitalPeopleMessages(messages, refs, !!refConvId),
          })
        );
        req.end();
        req.setEncoding("utf8");

        sendProgress("正在分析内容...\n");

        // 接收第一步响应
        const firstStepResult = await receiveDigitalPeopleFirstStep(req);
        session.close();

        sendProgress("正在提交视频生成任务...\n");

        // 第二步：提交任务获取taskId
        const taskSubmitResult = await axios.post(
          "https://api.tongyi.com/dialog/workflow/task/submit",
          {
            agentId: serviceConfig.digital_people_agent_id,
            cardCode: "tongyi-plugin-creator",
            msgId: firstStepResult.msgId,
            sessionId: firstStepResult.sessionId,
            operationType: "create",
            taskParam: {}
          },
          {
            headers: {
              Cookie: generateCookie(ticket),
              ...FAKE_HEADERS,
              Accept: "application/json, text/plain, */*",
              Origin: "https://www.tongyi.com",
              Referer: `https://www.tongyi.com/discover/chat?agentId=${serviceConfig.digital_people_agent_id}`,
            },
            timeout: 30000,
            validateStatus: () => true,
          }
        );

        const taskSubmitData = checkResult(taskSubmitResult);
        if (!taskSubmitData.data || !taskSubmitData.data.contents || !taskSubmitData.data.contents[0]) {
          throw new Error("Failed to submit digital people task");
        }

        const taskContent = JSON.parse(taskSubmitData.data.contents[0].content);
        const taskId = taskContent.taskId;

        sendProgress("任务已提交，正在生成视频...\n");

        // 第三步：轮询任务状态
        const videoResult = await pollDigitalPeopleTaskWithProgress(taskId, ticket, sendProgress);

        // 发送最终结果
        const finalContent = `\n数字人视频生成完成！\n\n视频地址：${videoResult.videoUrl}\n${videoResult.poster ? `封面图片：${videoResult.poster}` : ''}`;

        !transStream.closed &&
          transStream.write(
            `data: ${JSON.stringify({
              id: firstStepResult.sessionId + "-" + firstStepResult.msgId,
              model: DIGITAL_PEOPLE_MODEL_NAME,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { content: finalContent },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              created,
              video_url: videoResult.videoUrl,
              poster: videoResult.poster
            })}\n\n`
          );

        !transStream.closed && transStream.end("data: [DONE]\n\n");

        // 异步移除会话
        removeConversation(firstStepResult.sessionId, ticket).catch((err) => console.error(err));

      } catch (err) {
        logger.error("Digital people stream error:", err);
        !transStream.closed &&
          transStream.write(
            `data: ${JSON.stringify({
              id: util.uuid(false),
              model: DIGITAL_PEOPLE_MODEL_NAME,
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { content: `\n生成失败：${err.message}` },
                  finish_reason: "stop",
                },
              ],
              created,
            })}\n\n`
          );
        !transStream.closed && transStream.end("data: [DONE]\n\n");
      }
    })();

    return transStream;

  })().catch((err) => {
    session && session.close();
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Digital people stream error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createDigitalPeopleCompletionStream(model, messages, ticket, refConvId, retryCount + 1);
      })();
    }
    throw err;
  });
}

/**
 * 带进度更新的轮询数字人任务状态
 */
async function pollDigitalPeopleTaskWithProgress(
  taskId: string,
  ticket: string,
  sendProgress: (content: string) => void
): Promise<{videoUrl: string, poster?: string}> {
  const maxAttempts = 120; // 最多轮询120次，每次间隔5秒，总共10分钟
  const pollInterval = 5000; // 5秒间隔
  const initialDelay = 30000; // 初始延迟30秒再开始轮询

  sendProgress(`任务已提交，等待${initialDelay/1000}秒后开始生成...\n`);
  await new Promise(resolve => setTimeout(resolve, initialDelay));

  let lastStep = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await axios.post(
        "https://api.tongyi.com/dialog/creative/task/get?from=qianwen_saas&header=%7B%22X-Platform%22%3A%22app%22%7D",
        {
          taskIds: [taskId]
        },
        {
          headers: {
            Cookie: generateCookie(ticket),
            ...FAKE_HEADERS,
            Accept: "application/json, text/plain, */*",
            Origin: "https://www.tongyi.com",
            Referer: "https://www.tongyi.com/discover/chat?agentId=${serviceConfig.digital_people_agent_id}",
          },
          timeout: 30000,
          validateStatus: () => true,
        }
      );

      const taskData = checkResult(result);
      if (!taskData.data || !Array.isArray(taskData.data) || taskData.data.length === 0) {
        throw new Error("Invalid task polling response");
      }

      const task = taskData.data[0];
      const currentStep = task.step?.currentStep || 'unknown';

      // 只在步骤变化时发送进度更新，避免重复消息
      if (currentStep !== lastStep) {
        if (currentStep === 'Outline') {
          sendProgress("正在生成大纲...\n");
        } else if (currentStep === 'VideoCombine') {
          sendProgress("正在合成视频...\n");
        } else {
          sendProgress(`处理中... (${currentStep})\n`);
        }
        lastStep = currentStep;
      }

      // 每10次轮询发送一次进度提醒
      if (attempt > 0 && attempt % 10 === 0) {
        sendProgress(`继续处理中... (${Math.floor(attempt * pollInterval / 1000)}秒)\n`);
      }

      logger.info(`数字人任务状态: ${task.status}, 当前步骤: ${currentStep}, 轮询次数: ${attempt + 1}/${maxAttempts}`);

      if (task.status === 2) {
        if (task.videos && task.videos.length > 0) {
          logger.success(`数字人视频生成完成！视频URL: ${task.videos[0].url}`);
          return {
            videoUrl: task.videos[0].url,
            poster: task.videos[0].poster
          };
        } else {
          throw new Error("Task completed but no video found");
        }
      } else if (task.status === 0) {
        throw new Error(`Digital people task failed: ${task.statusMessage || 'Unknown error'}`);
      }

      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

    } catch (err) {
      logger.error(`流式轮询第${attempt + 1}次失败: ${err.message}`);
      if (attempt === maxAttempts - 1) {
        throw new Error(`数字人任务轮询失败，已重试${maxAttempts}次: ${err.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  throw new Error(`Digital people task timeout: exceeded maximum polling time (${maxAttempts * pollInterval / 1000 / 60} minutes)`);
}

export default {
  createCompletion,
  createCompletionStream,
  generateImages,
  getTokenLiveStatus,
  tokenSplit,
  createLawCompletion,
  createLawCompletionStream,
  createSolveCompletion,
  createSolveCompletionStream,
  createDigitalPeopleCompletion,
  createDigitalPeopleCompletionStream,
};
