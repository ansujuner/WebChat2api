# Third-party brand assets

The bundled provider marks identify the services supported by Chat2API. They are
not Chat2API's application logo and do not imply affiliation, sponsorship, or
endorsement. Brand names, trademarks, and artwork remain their respective owners'
property. This inventory records provenance, **not a grant of trademark rights or
a claim that these logos are licensed under the project's GPL-3.0-or-later license**. No
separate redistribution license was established by this asset audit; downstream
redistributors should review the applicable owners' terms.

## Official sources — verified 2026-09-06

Each URL below was linked as a favicon or touch icon by the corresponding official
site's public HTML. No icon aggregator, authenticated account, or private browser
profile was used. Files are bundled locally; displaying a provider does not send
an image request to its website.

| Provider | Official page | Image source | Local file |
| --- | --- | --- | --- |
| DeepSeek | [Chat](https://chat.deepseek.com/) | [Official SVG favicon](https://fe-static.deepseek.com/chat/favicon.svg) | `deepseek.svg` |
| GLM / 智谱清言 | [Chat](https://chatglm.cn/) | [Official favicon](https://chatglm.cn/favicon.ico) | `glm.png` |
| Kimi | [Kimi](https://www.kimi.com/) | [Official 192px touch icon](https://www.kimi.com/pwa-192.png) | `kimi.png` |
| MiniMax Agent | [Agent](https://agent.minimax.io/) | [Official touch icon](https://agent.minimax.io/assets/logo/apple-touch_v2.png) | `minimax.png` |
| Qwen / 千问 | [千问](https://www.qianwen.com/) | [Official favicon](https://img.alicdn.com/imgextra/i2/O1CN01taBbMS1CfyJoOt0lB_!!6000000000109-2-tps-80-80.png) | `qwen.png` |
| Qwen Chat (`qwen-ai`) | [Chat](https://chat.qwen.ai/) | [Official favicon](https://assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.2.91/favicon.png) | `qwen.png` |
| Z.ai | [Chat](https://chat.z.ai/) | [Official SVG favicon](https://z-cdn.chatglm.cn/z-ai/static/logo.svg) | `zai.svg` |
| Perplexity | [Official documentation](https://docs.perplexity.ai/docs/getting-started/overview) | [Official 192px favicon](https://docs.perplexity.ai/mintlify-assets/_mintlify/favicons/perplexity/rSPP83rcZL_iw-xo/_generated/favicon/android-chrome-192x192.png) | `perplexity.png` |
| Xiaomi MiMo | [MiMo](https://mimo.xiaomi.com/) | [Official favicon](https://cdn.cnbj1.fds.api.mi-img.com/aife/mimo-blog-fe/doc_build/mimo.ico) | `mimo.ico` |
| Arena | [Arena](https://arena.ai/) | [Official touch icon](https://arena.ai/apple-touch-icon.png) | `arena.png` |

Files live in `src/renderer/src/assets/providers/`. The adjacent `sources.json`
records the precise source and local SHA-256 hashes, retrieval date, and changes.

### Processing and display

- PNG and ICO files retain the original bytes. GLM's `.ico` URL actually returns
  PNG bytes, so its local extension is `.png`. MiMo's native 32px ICO is kept as an
  ICO, not upscaled or replaced with an invented logo.
- The two Qwen official sites supplied byte-identical favicons; their provider
  IDs deliberately share one local image, with both sources recorded.
- DeepSeek's SVG retains its official paths, colors, and view box; only an unused
  namespace and whitespace were removed.
- Z.ai's SVG retains its official geometry and colors. The two used CSS classes
  were converted to equivalent presentation attributes; unused CSS, the XML
  declaration, generator comment, and unused root metadata were removed.
- Bundled SVGs contain only static vector elements and presentation attributes:
  no scripts, event handlers, `foreignObject`, external references, CSS, embedded
  images, or animation. The targeted asset tests enforce this restriction and
  verify file signatures and hashes.
- Arena uses the official light touch icon with its own background, so it stays
  legible in either application theme without recoloring the mark.

All provider cards, the add-provider selector, login-guide headings, and the model
list use the shared `src/renderer/src/lib/providerIcons.ts` map. Unknown/custom
providers retain their generic fallback. The About page and header keep the
existing Chat2API application artwork. Sidebar navigation, settings controls,
status symbols, and the internal model-mapping symbol are generic UI icons, not
provider logos, and were not replaced.

## Updating

Recheck the public official page before changing a source URL. Verify the response
is actually an image (an HTTP 200 SPA HTML fallback is not an SVG), keep original
and processed hashes distinct, inspect the result, and update both this inventory
and `sources.json`. Never add remote runtime image URLs or copy a third-party
aggregator's licensing claim. Run `node --test tests/providers/provider-icons.test.js`
after updating the assets or shared mapping.
