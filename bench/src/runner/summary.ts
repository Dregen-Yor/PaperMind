/**
 * 摘要任务 Runner：论文全文 → 生产摘要函数（HuggingFace T5 递归归约）→ ROUGE 对比参考摘要。
 * 与 QA 任务（qa.ts）并列为 benchmark 的两大评测对象；
 * 复用 src/utils/abstractSummarizer 的生产实现，评测与应用跑同一份代码。
 */
import { summarizeAcademicText } from '../../../src/utils/abstractSummarizer'
import type { PaperMindConfig, BenchResult, EvalSample, PerSampleRecord, SampleError } from '../types'
import { computeSummaryMetrics } from '../metrics/rouge'
import { aggregate } from '../metrics/aggregate'
import { errorMessage } from './support'

export interface SummaryTaskArgs {
  samples: EvalSample[]
  config: PaperMindConfig
  hfToken: string
  /** 限制处理的论文数（每篇论文产一个摘要，与 QA runner 的「问题数」语义不同） */
  limit?: number
  gitSha: string
  model: string
  /** 注入替换生产实现，单测无需真实 HF 端点 */
  deps?: { summarize?: typeof summarizeAcademicText }
}

export async function runSummaryTask(args: SummaryTaskArgs): Promise<BenchResult> {
  const { samples, config, hfToken, limit, gitSha, model } = args
  const summarize = args.deps?.summarize ?? summarizeAcademicText

  // 缺 token 是整轮任务的启动前置而非单样本失败，立即抛错让调用方先修环境
  if (!hfToken) {
    throw new Error('缺少环境变量 HF_TOKEN（Hugging Face Inference API token）')
  }

  const perSample: PerSampleRecord[] = []
  const errors: SampleError[] = []
  let total = 0

  for (const sample of samples) {
    // 没有参考摘要无法算 ROUGE，直接跳过且不计入分母
    if (!sample.referenceAbstract) continue
    if (limit !== undefined && total >= limit) break
    total++

    const fullText = sample.pages.join('\n\n')
    try {
      const summary = await summarize(fullText, hfToken)
      // 拷贝为索引签名类型，便于按裁定删除 compressionRatio 键
      const metrics: Record<string, number> = {
        ...computeSummaryMetrics(summary, sample.referenceAbstract, fullText.length),
      }
      // 空摘要时压缩比失去意义（'   ' → 3/100 会让端点故障看起来像「压缩得很好」），
      // 删掉该键交给聚合层缺指标剔除；ROUGE 全 0 保留（空摘要确实没产出内容）
      if (metrics.empty === 1) delete metrics.compressionRatio
      perSample.push({
        id: sample.paperId,
        paperId: sample.paperId,
        source: sample.source,
        metrics,
        summary,
      })
    } catch (e) {
      // 网络异常记入 errors 并从 completed 分母剔除，与「成功但返回空」（empty=1）分属两种成因
      errors.push({ sampleId: sample.paperId, stage: 'summarize', message: errorMessage(e) })
    }
  }

  const raw = aggregate(perSample)
  // empty 的 0/1 均值即为比率，重命名为 emptyRate 让报表列名自解释
  const metrics: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    metrics[key === 'empty' ? 'emptyRate' : key] = value
  }

  return {
    task: 'summary',
    config,
    meta: {
      model,
      timestamp: new Date().toISOString(),
      gitSha,
      completed: perSample.length,
      total,
    },
    metrics,
    perSample,
    errors,
  }
}
