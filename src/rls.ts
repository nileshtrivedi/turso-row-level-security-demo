import { Client as LibsqlClient, ResultSet, Row } from "@libsql/client/web";
import { Parser } from "node-sql-parser";

export async function secureQuery(client: LibsqlClient, query: string, user: Row, policies: ResultSet | undefined) : Promise<string>{
  // Check that this user is allowed to run this query
  // If necessary, this can add additional WHERE clauses and modify incoming/new values
  // If not allowed, throw error with message
  if(!user) throw new Error("user missing");
  const parser = new Parser();
  const opt = {database: 'sqlite'};
  let { ast } = parser.parse(query, opt);

  if(Array.isArray(ast)) {
    if (ast.length != 1) throw new Error("Only one SQL statement per query is allowed");
    ast = ast[0];
  }
  // console.log(JSON.stringify(ast, null, 2));
  if(ast.type == "alter" || ast.type == "create" || ast.type == "use" || ast.type == "replace")
    throw new Error("Operation disallowed");

  if(ast.type == 'select')
    if (ast.from == null || ast.from.length != 1)
      throw new Error("SELECT only from one table for now");

  let table_name = ast.type == 'select' ? ast.from![0].table : ast.table[0].table;
  
  let action: ("select" | "update" | "insert" | "delete") = ast.type;

  if(!policies) throw new Error("Policies not yet fetched");
  let policy: Row | undefined = policies.rows.find(r => r["table_name"] == table_name && r["action"] == action);
  if(!policy) throw new Error("Operation disallowed by policy");
  
  let using_clause = policy["using_clause"] as string;
  let with_check_clause = policy["withcheck_clause"] as string;
  
  // Apply with_check_clause to new values for insert and update
  // console.log("ast=", JSON.stringify((ast as any), null, 2), {with_check_clause}, {using_clause});
  if(with_check_clause){
    with_check_clause = with_check_clause
                  .replaceAll('$$CURRENT_USER$$', `'${user.id as string}'`)
                  .replaceAll('$$CURRENT_ROLE$$', `'${user.role as string}'`);
    if (ast.type == "insert"){
      ast.values = ast.values.filter(val => {
        // check if new values satisfy the with_check_clause 
        // column names might not be present!!
        let row : {[key: string]: any} = {};
        (ast as any).columns.forEach((col: string, index: number) => {
          row[col] = val.value[index].value
        });
        let result = evaluateSQLExpression(row, with_check_clause, parser);
        console.log({result});
        return result;
      });
      if(ast.values.length == 0) throw new Error("all inserts rejected by withcheck policy");
    } else if (ast.type == "update"){
      // check SET column_name = value for satisfying with_check_clause 
      let row : {[key: string]: any} = {};
      (ast as any).set.forEach((assignment: any, index: number) => {
        row[assignment.column] = assignment.value.value;
      });
      let result = evaluateSQLExpression(row, with_check_clause, parser);
      console.log({result});
      if(!result) throw new Error(`updates violate withcheck policy on ${table_name}`);
    }
  }
  
  if(using_clause){
    if (ast.type == "select" || ast.type == "update" || ast.type == "delete"){
      // Apply using clause as WHERE select, delete, update
      using_clause = using_clause
                    .replaceAll('$$CURRENT_USER$$', `'${user.id as string}'`)
                    .replaceAll('$$CURRENT_ROLE$$', `'${user.role as string}'`);
      let expr = parseSQLExpression(using_clause, parser);
      if((ast as any).where == null) {
        (ast as any).where = expr;
      } else {
        (ast as any).where = {
          type: "binary_expr",
          operator: "AND",
          left: expr,
          right: (ast as any).where
        }
      }
    }
  }

  // console.log("ast=", JSON.stringify(ast as any, null, 2));
  return parser.sqlify(ast, opt);
}

function parseSQLExpression(clause: string, parser: Parser){
  const sql = `SELECT (${clause}) AS result`;
  console.log({sql});
  const { ast } = parser.parse(sql);
  // console.log({ast});
  return (ast as any).columns[0].expr;
}

function evaluateSQLExpression(obj: any, clause: string, parser: Parser) {
  // evaluate boolean expressions as if running on object obj being the row
  console.log("evaluateSQLExpression", obj, clause);
  const sql = `SELECT (${clause}) AS result`;
  // console.log({sql});
  const { ast } = parser.parse(sql);
  const result = evaluateAST((ast as any).columns[0].expr, obj);
  return !!result; // Convert result to boolean
}

function evaluateAST(ast: any, obj: { [key: string]: string }) {
  console.log("evaluateAST", ast, obj);
  if (ast.type === 'binary_expr') {
    const leftValue: any = evaluateAST(ast.left, obj);
    const rightValue: any = evaluateAST(ast.right, obj);
    console.log({leftValue}, {rightValue}, ast.operator);
    
    switch (ast.operator) {
      case '+': return leftValue + rightValue;
      case '-': return leftValue - rightValue;
      case '*': return leftValue * rightValue;
      case '/': return leftValue / rightValue;
      case '>': return leftValue > rightValue;
      case '>=': return leftValue >= rightValue;
      case '<': return leftValue < rightValue;
      case '<=': return leftValue <= rightValue;
      case '=': return leftValue === rightValue;
      case 'AND': return leftValue && rightValue;
      case 'OR': return leftValue || rightValue;
      // Add more cases for other operators as needed
      default: throw new Error(`unknown SQL operator: ${ast.operator}`);
    }
  } else if (ast.type === 'column_ref') {
    const columnName: string = ast.column;
    if (obj.hasOwnProperty(columnName)) {
      return obj[columnName];
    }
  } else if (ast.type === 'number' || ast.type === 'single_quote_string') {
    return ast.value;
  }
}
