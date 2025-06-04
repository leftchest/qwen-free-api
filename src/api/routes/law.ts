import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import chat from "@/api/controllers/chat.ts";

export default {
  prefix: "/v1/agent",

  post: {
    "/consultations": async (request: Request) => {
      request
        .validate('body.conversation_id', v => _.isUndefined(v) || _.isString(v))
        .validate("body.messages", _.isArray)
        .validate("headers.authorization", _.isString);

      // 复用现有的token处理逻辑
      const tokens = chat.tokenSplit(request.headers.authorization);
      // 随机挑选一个ticket
      const token = _.sample(tokens);
      const { model, conversation_id: convId, messages, stream } = request.body;

      // 根据模型类型选择不同的处理函数
      if (model === "solve_txt" || model === "solve_pic") {
        // 解题模型
        if (stream) {
          const stream = await chat.createSolveCompletionStream(
            model,
            messages,
            token,
            convId
          );
          return new Response(stream, {
            type: "text/event-stream",
          });
        } else {
          return await chat.createSolveCompletion(
            model,
            messages,
            token,
            convId
          );
        }
      } else {
        // 法律咨询模型（默认）
        if (stream) {
          const stream = await chat.createLawCompletionStream(
            model,
            messages,
            token,
            convId
          );
          return new Response(stream, {
            type: "text/event-stream",
          });
        } else {
          return await chat.createLawCompletion(
            model,
            messages,
            token,
            convId
          );
        }
      }
    },
  },
};
