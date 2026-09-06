import deepseekIcon from '@/assets/providers/deepseek.svg'
import glmIcon from '@/assets/providers/glm.png'
import kimiIcon from '@/assets/providers/kimi.png'
import minimaxIcon from '@/assets/providers/minimax.png'
import mimoIcon from '@/assets/providers/mimo.ico'
import perplexityIcon from '@/assets/providers/perplexity.png'
import qwenIcon from '@/assets/providers/qwen.png'
import zaiIcon from '@/assets/providers/zai.svg'
import arenaIcon from '@/assets/providers/arena.png'

// Official, locally bundled brand marks. Provenance: assets/providers/sources.json
// and THIRD_PARTY_ASSETS.md. Unknown/custom providers keep their generic icon.
export const providerIcons: Readonly<Record<string, string | undefined>> = Object.freeze(
  Object.assign(Object.create(null), {
    deepseek: deepseekIcon,
    glm: glmIcon,
    kimi: kimiIcon,
    minimax: minimaxIcon,
    mimo: mimoIcon,
    perplexity: perplexityIcon,
    qwen: qwenIcon,
    'qwen-ai': qwenIcon,
    zai: zaiIcon,
    arena: arenaIcon,
  })
)
