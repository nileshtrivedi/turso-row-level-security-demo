import { Client as LibsqlClient, createClient } from "@libsql/client/web";
import { Router, RouterType } from "itty-router";
import { secureQuery } from "./rls";
export interface Env {
  LIBSQL_DB_URL?: string; // Turso DB's URL
  LIBSQL_DB_AUTH_TOKEN?: string; // Turso DB's auth token
  router?: RouterType;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if(env.router === undefined) env.router = buildRouter(env);
    return env.router.handle(request);
	},
};

function buildLibsqlClient(env: Env): LibsqlClient {
  const url = env.LIBSQL_DB_URL?.trim();
  if (url === undefined) throw new Error("LIBSQL_DB_URL env var is not defined");

  const authToken = env.LIBSQL_DB_AUTH_TOKEN?.trim();
  if (authToken === undefined) throw new Error("LIBSQL_DB_AUTH_TOKEN env var is not defined");

  return createClient({ url, authToken });
}

async function computePasswordHash(password: string){
  const password_utf8 = new TextEncoder().encode(password);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', password_utf8))).map(b => b.toString(16).padStart(2, '0')).join('');
}

function buildRouter(env: Env): RouterType {
  const router = Router();

  router.post("/query", async (request) => {
    try {
      const client = buildLibsqlClient(env);
      const query = await request.text();
      const auth_header = request.headers.get('Authorization') || 'dummy-password-for-anonymous';
      const password = auth_header.replace('Bearer ', '');
  
      // identify the user (could be anonymous)
      const current_user = (await client.execute({
        sql: "select * from _users where password_hash = hex(sha256(?)) limit 1",
        args: [password]
      })).rows[0];

      const policies = await client.execute({sql: "select * from _policies", args: []});
      
      let safeSql = await secureQuery(client, query, current_user, policies);
      console.log("query = ", query);
      console.log("safeSql = ", safeSql);

      const rs = await client.execute({ sql: safeSql, args: [] });
      return Response.json(rs);
    } catch (e) {
        throw e;
        // return new Response(`${e}`, {status: 500});
    }
  });

  router.post("/register", async (request) => {
      const client = buildLibsqlClient(env);
      const req: {email: string, password: string, display_name: string | null} = await request.json();
      const email = req.email;
      const password = req.password;

      if (typeof email !== "string" || email.length < 6)
        return new Response("email length must be >= 6", { status: 400 });

      if (typeof password !== "string" || password.length < 12) 
        return new Response("password length must be >= 12", { status: 400 });

        const uid = crypto.randomUUID();

      try {
          await client.execute({
              sql: "insert into _users (id, username, password_hash, role, display_name) values (?, ?, hex(sha256(?)), 'regular', ?)",
              args: [uid, email, password, req.display_name],
          });
      } catch (e) {
          return new Response(`signup failed: ${e}`, {status: 500});
      }

      return new Response("Success");
  });

  router.all("*", () => new Response("Not Found.", { status: 404 }));

  return router;
}

