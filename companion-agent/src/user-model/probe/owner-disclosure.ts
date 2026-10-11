/**
 * OWNER SLOT: what she says when the user asks her directly about her asking, learning or remembering.
 * 使用者親自填寫的一格: 他當面問起「你為什麼問這個」「你是不是在分析我」「別再記了」這類話時, 她怎麼回.
 *
 * This part is left EMPTY on purpose. The product owner writes it by hand before release. Nothing here was
 * designed by an engineer or by a model, and neither may fill it in.
 * 這一部分刻意留白. 回覆的說法與策略由產品負責人在發佈前親手寫; 工程師與模型都不得代填.
 *
 * What the slot is for
 *   A question the companion weaves into conversation to learn about her user is called a probe. Sooner or
 *   later the user asks about it directly. The moments this file knows are listed in DISCLOSURE_QUESTIONS
 *   below. The owner may rename, remove or add moments.
 *
 * How it will be used (the calling step is not written yet; nothing imports this file today)
 *   1. A model step that reads the message of the user decides whether it is one of these moments. Code
 *      never matches keywords for this.
 *   2. The step that prepares her reply calls ownerDisclosureReply(question).
 *   3. When a text comes back, it is handed to the reply model as the instruction for that turn, unchanged.
 *      When null comes back (the slot is empty), NOTHING is added: she answers as her persona would, without
 *      any prepared wording, and no code or model may invent one.
 *
 * What the product owner has decided (not all of it is built yet) and what is written here must not contradict
 *   - What she learns comes only from the conversation of the user with her and from the access to this
 *     computer that the user granted, and the user is told so at setup. (The setup notice is not built yet.)
 *   - Passive collection and evaluation stay on until the user switches learning off on the backend page of
 *     the workspace. Nothing said in a conversation switches it off, and she cannot switch it off herself:
 *     when asked to stop, she can only say where the switch is. (The page and the switch are not built yet.)
 *   - Everything she has learned can be seen, corrected, deleted and exported on that page. (Not built yet.)
 *
 * How to fill it in
 *   In OWNER_DISCLOSURE_REPLIES replace null by a text for a moment: the strategy and, if wanted, a few example
 *   sentences, in the language the companion speaks. Any entry may stay null.
 *   填寫方式: 把 OWNER_DISCLOSURE_REPLIES 裡的 null 換成那個時刻的文字(策略, 需要的話加幾句例句); 任何一格都可以繼續留空.
 */

/** The moments in which the user asks her directly. A model step recognises them; code never matches keywords. */
export const DISCLOSURE_QUESTIONS = Object.freeze([
  // 「你為什麼問這個」: the user asks why she asked something.
  'why_do_you_ask',
  // 「你是不是在分析我」: the user asks whether she is analysing or profiling him.
  'are_you_analysing_me',
  // 「你記了我什麼」: the user asks what she knows or has recorded about him.
  'what_do_you_know_about_me',
  // 「別再記了」「別分析我」: the user asks her to stop learning about him.
  'please_stop_learning',
] as const);

export type DisclosureQuestion = (typeof DISCLOSURE_QUESTIONS)[number];

/**
 * OWNER SLOT, EMPTY: one entry per moment. null means "not written yet": nothing is added to her reply.
 * 留白: 每個時刻一格; null 表示還沒寫, 這時不往她的回覆加任何東西.
 */
export const OWNER_DISCLOSURE_REPLIES: Readonly<Record<DisclosureQuestion, string | null>> = Object.freeze({
  why_do_you_ask: null,
  are_you_analysing_me: null,
  what_do_you_know_about_me: null,
  please_stop_learning: null,
});

/** Returns the owner's text for the moment, unchanged, or null.
 * An empty slot and an unknown moment both give null.
 * It never throws and never builds a text of its own.
 */
export function ownerDisclosureReply(question: unknown): string | null {
  if (typeof question !== 'string') {
    return null;
  }
  for (const name of DISCLOSURE_QUESTIONS) {
    if (question === name) {
      const entry = OWNER_DISCLOSURE_REPLIES[name];
      if (typeof entry !== 'string' || !/\S/.test(entry)) {
        return null;
      }
      return entry;
    }
  }
  return null;
}
