# Row-level security for Turso

This is a small Cloudflare Worker that provides an authorization wrapper over Turso database. Somewhat like PostgREST, it enforces access-control policies defined in the database. In a way, it provides the missing Row-level Security feature in SQLite while retaining SQL as the query interface.

It connects to your Turso DB instance, reads two tables `_users` and `_policies` with a specific schema and enforces row-level security policy for all your other tables, allowing your to directly send SQL queries from the frontend. This makes it possible to create multi-user, backend-less apps without any servers, containers or lambdas. Cloudflare Worker and Turso DB make it extremely cheap for low-concurrency use-cases for which Turso/Sqlite is suitable.

## APIs

There are the APIs:

- `POST /register`: Takes an username and password and adds a new user account in db.
- `POST /query`   : Takes a SQL query (only SELECT/INSERT/UPDATE/DELETE) with the password in the `Authorization` header, looks at applicable policies and either modifies the query to account for restricted access or blocks it altogether.

You can see full API definitions as well examples in the [Insomnia collection](/apis_insomnia.json)

## Tutorial: Let's build the backend for a multi-user To-Do list app

First create your Turso DB instance.:
`turso db create cloudflare-rls-demo --enable-extensions`
We rely on [Crypto and UUID extensions](https://docs.turso.tech/reference/extensions).

Get the database URL. This will be used as the `LIBSQL_DB_URL` env variable and needs to be updated in `wrangler.toml`:
`turso db show cloudflare-rls-demo`

Create an auth token for this db. This will be used as the `LIBSQL_DB_AUTH_TOKEN` env variable and needs to be updated in `.dev.vars` for local development:
`turso db tokens create cloudflare-rls-demo`

Now start a shell for this db:
`turso db shell cloudflare-rls-demo`

Create your `_users` table:

```
create table _users (
    id varchar(255) primary key,
    username varchar(128) check(length(username) >= 4) not null,
    password_hash varchar(255) unique not null,
    role varchar(128) check (role in ('anon', 'admin', 'regular')) not null default 'regular',
    display_name varchar(255)
    -- add other columns needed for your app
);

-- define your users. I like to create one for anonymous/public access and another for admin
-- 
insert into _users (id, username, password_hash, role, display_name) values 
  ('anon', 'anon', hex(sha256('dummy-password-for-anonymous')), 'anon', 'Anonymous'),
  ('admin', 'admin', hex(sha256('must-replace-this-with-a-securerandom')), 'admin', 'Administrator');

```

Now create the `_policies` table:

```
-- Now we create a table where access policies for actions on tables are whitelisted
create table _policies (
    table_name varchar(255) not null,
    action varchar(255) not null CHECK (action IN ('select', 'insert', 'update', 'delete')),
    using_clause varchar(1024),
    withcheck_clause varchar(1024),
    primary key (table_name, action)
);
```

`using_clause_sql`` defines which rows are made visible for select, update, delete.
`withcheck_clause_js`` defines javascript filter for incoming rows for insert, update.
In both, `$$CURRENT_USER$$` will be replaced by the actual user_id who has sent the query. Similarly, `$$CURRENT_ROLE$$` will be replaced by the user's role (eg: "anon" / "admin" / "regular")

For example, to allow users to read only their own tasks:
```
insert into _policies (table_name, action, using_clause, withcheck_clause) values 
('tasks', 'select', 'user_id = $$CURRENT_USER$$', null),
('tasks', 'insert', 'true', 'user_id = $$CURRENT_USER$$');
```

Now, create your tasks table:
```
create table tasks (
    id serial primary key,
    todo text not null, 
    user_id varchar(255) not null references _users(id)
);
insert into tasks (id, todo, user_id) values (1, 'anon task', 'anon'), (2, 'admin task', 'admin');
```

## How It Works

`worker.ts` implements the 2 API routes in a Cloudflare Worker. 

When `/query` is invoked, first it fetches the record from the `_users` table. We use [node-sql-parser]() to parse the incoming SQL queries. Similar to PostgreSQL's `CREATE POLICY` statements, our policies too provide two kind of validations via SQL's boolean expressions that can use two special values (`$$CURRENT_USER$$` and `$$CURRENT_ROLE$$`): 

- `using_clause` that gets added to incoming queries' as a `WHERE` clause. This controls the visibility of existing rows for `SELECT`, `UPDATE`, and `DELETE` statements.
- `withcheck_clause` validates new incoming values for `INSERT` and `UPDATE` statements.