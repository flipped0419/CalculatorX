/**
 * Copyright (c) 2026 StartYi. All rights reserved.
 * @file CasWorksheetSession.ts
 * @description CAS 多行工作表的稳定行号、静态快照与动态依赖计算
 * @author StartYi
 * @date 2026/10/19 23:40
 */

/** 行号不随删除操作复用，以免既有公式中的引用悄悄指向其他表达式。 */
export type CasRowStatus = 'empty' | 'ready' | 'error';

export interface CasWorksheetRow {
  id: number;
  inputLatex: string;
  outputLatex: string;
  evaluationLatex: string;
  status: CasRowStatus;
  errorMessage: string;
}

export interface CasWorksheetStoredRow {
  id: number;
  inputLatex: string;
  frozenLatex: string;
  freezeError: string;
}

export interface CasWorksheetSnapshot {
  version: number;
  nextRowId: number;
  rows: CasWorksheetStoredRow[];
}

export type CasWorksheetEvaluator = (latex: string) => Promise<string>;

interface InternalRow extends CasWorksheetRow {
  frozenLatex: string;
  freezeError: string;
}

interface CasReference {
  start: number;
  end: number;
  kind: string;
  rowId: number;
}

const MAX_ROWS = 100;
const MAX_FORMULA_LENGTH = 8192;
const MAX_SNAPSHOT_LENGTH = 1000000;
const SNAPSHOT_VERSION = 1;

/**
 * $n：每次重算都读取第 n 行最新结果。
 * #n：在写入本行的时刻拷贝第 n 行结果，此后不会受原行修改影响。
 * 带反斜线的字面量（例如 \#1）不会被识别为行引用。
 */
function scanReferences(latex: string): CasReference[] {
  const references: CasReference[] = [];
  const pattern = /(^|[^\\])([#$])([1-9][0-9]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(latex)) !== null) {
    const rowId = Number(match[3]);
    if (!Number.isSafeInteger(rowId)) {
      throw new Error('引用行号超出安全整数范围');
    }
    const start = match.index + match[1].length;
    references.push({ start: start, end: start + match[2].length + match[3].length,
      kind: match[2], rowId: rowId });
  }
  return references;
}

function groupLatex(latex: string): string {
  return '\\left(' + latex + '\\right)';
}

function copyRow(row: InternalRow): CasWorksheetRow {
  return {
    id: row.id,
    inputLatex: row.inputLatex,
    outputLatex: row.outputLatex,
    evaluationLatex: row.evaluationLatex,
    status: row.status,
    errorMessage: row.errorMessage
  };
}

export class CasWorksheetSession {
  private rows: InternalRow[] = [];
  private nextRowId: number = 1;
  private revision: number = 0;

  public getRows(): CasWorksheetRow[] {
    return this.rows.map((row: InternalRow): CasWorksheetRow => copyRow(row));
  }

  /**
   * 冻结 #n 的当前结果；若目标尚未计算或不存在，则保留错误而不将其
   * 变成后续可能意外生效的动态引用。
   */
  private freezeStaticReferences(input: string): { latex: string; error: string } {
    let output = '';
    let cursor = 0;
    try {
      const references = scanReferences(input);
      for (const reference of references) {
        output += input.substring(cursor, reference.start);
        if (reference.kind === '#') {
          const target = this.rows.find((row: InternalRow): boolean => row.id === reference.rowId);
          if (!target || target.status !== 'ready' || !target.outputLatex) {
            throw new Error('第 ' + reference.rowId + ' 行尚无可复制的计算结果');
          }
          output += groupLatex(target.outputLatex);
        } else {
          output += input.substring(reference.start, reference.end);
        }
        cursor = reference.end;
      }
      output += input.substring(cursor);
      return { latex: output, error: '' };
    } catch (error) {
      return { latex: input, error: String(error) };
    }
  }

  public addRow(inputLatex: string = ''): number {
    if (this.rows.length >= MAX_ROWS) {
      throw new Error('工作表最多支持 ' + MAX_ROWS + ' 行');
    }
    this.validateInput(inputLatex);
    const frozen = this.freezeStaticReferences(inputLatex);
    const rowId = this.nextRowId;
    this.nextRowId += 1;
    this.rows.push({
      id: rowId, inputLatex: inputLatex, frozenLatex: frozen.latex,
      freezeError: frozen.error, outputLatex: '', evaluationLatex: '',
      status: 'empty', errorMessage: ''
    });
    this.revision += 1;
    return rowId;
  }

  public updateRow(id: number, inputLatex: string): void {
    this.validateInput(inputLatex);
    const row = this.rows.find((item: InternalRow): boolean => item.id === id);
    if (!row) {
      throw new Error('找不到第 ' + id + ' 行');
    }
    const frozen = this.freezeStaticReferences(inputLatex);
    row.inputLatex = inputLatex;
    row.frozenLatex = frozen.latex;
    row.freezeError = frozen.error;
    row.evaluationLatex = '';
    row.outputLatex = '';
    row.errorMessage = '';
    row.status = 'empty';
    this.revision += 1;
  }

  public deleteRow(id: number): void {
    const oldLength = this.rows.length;
    this.rows = this.rows.filter((row: InternalRow): boolean => row.id !== id);
    if (this.rows.length === oldLength) {
      throw new Error('找不到第 ' + id + ' 行');
    }
    this.revision += 1;
  }

  private validateInput(latex: string): void {
    if (typeof latex !== 'string' || latex.length > MAX_FORMULA_LENGTH) {
      throw new Error('公式长度超出限制');
    }
  }

  /**
   * 使用本次修订的行快照求值，避免异步计算过程中用户编辑造成旧结果覆盖新结果。
   * 各依赖只求值一次，向前引用和循环引用都显式处理。
   */
  public async recalculate(evaluator: CasWorksheetEvaluator): Promise<CasWorksheetRow[]> {
    const revisionAtStart = this.revision;
    const pending: InternalRow[] = this.rows.map((row: InternalRow): InternalRow => ({ ...row }));
    const byId: Map<number, InternalRow> = new Map<number, InternalRow>();
    const states: Map<number, string> = new Map<number, string>();
    for (const row of pending) {
      byId.set(row.id, row);
    }

    const evaluate = async (row: InternalRow): Promise<string> => {
      if (states.get(row.id) === 'done') {
        if (row.status === 'error') {
          throw new Error(row.errorMessage);
        }
        return row.outputLatex;
      }
      if (states.get(row.id) === 'visiting') {
        throw new Error('循环引用：第 ' + row.id + ' 行');
      }
      states.set(row.id, 'visiting');
      try {
        if (!row.inputLatex.trim()) {
          row.status = 'empty';
          row.outputLatex = '';
          row.evaluationLatex = '';
          return '';
        }
        if (row.freezeError) {
          throw new Error(row.freezeError);
        }
        const references = scanReferences(row.frozenLatex);
        let expanded = '';
        let cursor = 0;
        for (const reference of references) {
          expanded += row.frozenLatex.substring(cursor, reference.start);
          if (reference.kind !== '$') {
            throw new Error('未能冻结第 ' + reference.rowId + ' 行的静态引用');
          }
          const source = byId.get(reference.rowId);
          if (!source) {
            throw new Error('引用的第 ' + reference.rowId + ' 行不存在');
          }
          const value = await evaluate(source);
          if (!value) {
            throw new Error('引用的第 ' + reference.rowId + ' 行没有计算结果');
          }
          expanded += groupLatex(value);
          cursor = reference.end;
        }
        expanded += row.frozenLatex.substring(cursor);
        if (expanded.length > MAX_SNAPSHOT_LENGTH) {
          throw new Error('展开后的公式过长');
        }
        row.evaluationLatex = expanded;
        const result = await evaluator(expanded);
        if (typeof result !== 'string' || result.length === 0) {
          throw new Error('计算引擎没有返回有效结果');
        }
        row.outputLatex = result;
        row.errorMessage = '';
        row.status = 'ready';
        return result;
      } catch (error) {
        row.outputLatex = '';
        row.errorMessage = String(error);
        row.status = 'error';
        throw error;
      } finally {
        states.set(row.id, 'done');
      }
    };

    for (const row of pending) {
      try {
        await evaluate(row);
      } catch (_error) {
        // 错误属于本行，不阻止不依赖该行的其他公式继续计算。
      }
    }
    if (revisionAtStart === this.revision) {
      this.rows = pending;
    }
    return this.getRows();
  }

  public exportSnapshot(): CasWorksheetSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      nextRowId: this.nextRowId,
      rows: this.rows.map((row: InternalRow): CasWorksheetStoredRow => ({
        id: row.id, inputLatex: row.inputLatex,
        frozenLatex: row.frozenLatex, freezeError: row.freezeError
      }))
    };
  }

  public loadSnapshot(snapshot: CasWorksheetSnapshot): void {
    if (!snapshot || snapshot.version !== SNAPSHOT_VERSION ||
        !Array.isArray(snapshot.rows) || snapshot.rows.length > MAX_ROWS ||
        !Number.isSafeInteger(snapshot.nextRowId) || snapshot.nextRowId < 1) {
      throw new Error('工作表快照格式无效');
    }
    const seen: Set<number> = new Set<number>();
    const loaded: InternalRow[] = [];
    for (const stored of snapshot.rows) {
      if (!stored || !Number.isSafeInteger(stored.id) || stored.id < 1 ||
          stored.id >= snapshot.nextRowId || seen.has(stored.id) ||
          typeof stored.inputLatex !== 'string' ||
          typeof stored.frozenLatex !== 'string' ||
          typeof stored.freezeError !== 'string' ||
          stored.inputLatex.length > MAX_FORMULA_LENGTH ||
          stored.frozenLatex.length > MAX_SNAPSHOT_LENGTH ||
          stored.freezeError.length > 500) {
        throw new Error('工作表中存在无效计算行');
      }
      seen.add(stored.id);
      loaded.push({
        id: stored.id, inputLatex: stored.inputLatex, frozenLatex: stored.frozenLatex,
        freezeError: stored.freezeError, outputLatex: '', evaluationLatex: '',
        status: 'empty', errorMessage: ''
      });
    }
    this.rows = loaded;
    this.nextRowId = snapshot.nextRowId;
    this.revision += 1;
  }
}
