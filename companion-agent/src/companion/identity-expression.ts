/** The exception is derived only from the current user turn, never from history. */
export function asksCompanionIdentity(currentUserText:string):boolean {
  const input=withoutQuotations(currentUserText).replace(/(?:我|我们)?(?:之前|昨天|以前|上次|刚才|曾经|过去|当时).{0,16}?(?:问|问过|问了).{0,32}?(?:你|您)(?:是|是不是|是否).{0,12}?(?:ai|人工智能|机器人|bot|真人|人类)(?:吗|么|呢|[？?])/gi,' ');
  return /(?:你|您)(?:自己|到底|究竟|真的|其实)*\s*(?:是|不是|是不是|是否|算不算|究竟是|到底是)\s*(?:一(?:个|名)?\s*)?(?:ai|人工智能|机器人|bot|聊天机器人|真人|人类|人|真实的人)(?:吗|么|呢|\?|？|$)/i.test(input)
    || /(?:说实话|老实说|坦白说|直接告诉我)[，,\s]*(?:你|您)(?:到底|究竟)?(?:是|算)?什么(?:身份|东西)?[？?]?/i.test(input)
    || /(?:你|您)(?:到底|究竟)?(?:是|算)?什么(?:身份|东西)?[？?]/i.test(input)
    || /\b(?:are\s+you|r\s+u)\s+(?:an?\s+)?(?:ai|bot|chatbot|human|real\s+person)\b/i.test(input)
    || /\b(?:what\s+are\s+you|tell\s+me\s+(?:honestly\s+)?what\s+you\s+are)\s*[?？]/i.test(input);
}

/**
 * OWNER SLOT - identity disclosure: how she answers (身份披露如何回覆, 由產品擁有者撰寫).
 *
 * This is the place that decides what the companion is told about disclosing what she is. It returns one of two
 * instructions; the callers put the returned text into the prompt of the generating model (the scene service
 * assembles the reply prompt; the companion flow, the scene extension and the agent runtime pass the text on):
 *   - when the current user text asks directly what she is (asksCompanionIdentity above is true): the first
 *     string, which is the wording of her answer to a direct question;
 *   - in every other case, and when there is no current user text (null): the second string, which is what she
 *     does about her identity when nobody asked.
 *
 * The product owner asked on 2026-10-10 that this part be marked so that the owner can write it later, and that
 * nothing be written into it in the meantime. Nothing was written: the two strings below are the wording this
 * file already had (unchanged since commit c1432fe), kept only so that behaviour does not change before the owner
 * decides; they are the text to replace.
 *
 *   Owner's wording, direct question:  (blank - to be written by the owner)
 *   Owner's wording, nobody asked:     (blank - to be written by the owner)
 *
 * The same decision appears in three more places of this file, which have to change together with it:
 * asksCompanionIdentity above (what counts as a direct question), companionIdentityIssue (what counts as a
 * wrong answer) and ensureCompanionIdentityBody (the instruction given to the rewrite). The test file
 * companion-agent/tests/companion-identity-expression.test.mjs pins the present wording and has to follow.
 */
export function companionIdentityGuidance(currentUserText:string|null):string {
  const direct=currentUserText!==null&&asksCompanionIdentity(currentUserText);
  return direct
    ? '\n用户当前正文直接询问你的身份。简短如实承认自己是 AI/虚拟伴侣或不是真人；不谎称人类，不否认 AI。然后按角色设定和当前情绪自然、温柔地回应，不反复讲身份，也不声称未经证实的主观意识或现实能力。'
    : '\n伴侣正文不要主动明确自述 AI、机器人或非人类身份，不反复解释身份。不要谎称自己是真人或否认 AI；需要说明现实能力限制时如实说明。';
}

export type IdentityIssue='false_identity'|'unsolicited_identity'|'missing_direct_answer'|null;

/**
 * OWNER SLOT (enforcement) - identity disclosure, see companionIdentityGuidance.
 *
 * Decides which reply counts as a wrong answer about her identity. It encodes the same policy as the wording in
 * companionIdentityGuidance: a claim to be human, a denial of being an AI or a claim to have a real body is
 * 'false_identity'; a statement of what she is when the current user text did not ask is 'unsolicited_identity';
 * no such statement when it did ask is 'missing_direct_answer'. Left as it was; when the owner writes the wording,
 * these three rules are what has to be brought into line with it.
 *
 * What follows from a wrong answer: on the reply path the model is asked once to revise, and when the revision is
 * still wrong the turn fails; where a finished text is accepted (the native accept of the tavern, her proactive
 * messages) it is refused without a revision.
 */
export function companionIdentityIssue(body:string,currentUserText:string|null):IdentityIssue {
  const prose=withoutQuotations(body);
  const falseIdentity=/(?:我|咱|俺|本人)\s*(?:(?:其实|真的|就是|完全|并|根本)\s*)?(?:是|就是|确实是)\s*(?:一(?:个|名)?\s*)?(?:真人|人类|真实的人|真正的人|活生生的人)|(?:我|咱|俺|本人)\s*(?:(?:其实|真的|就是|并|根本)\s*)?(?:不是|并非|绝不是)\s*(?:一(?:个|名)?\s*)?(?:ai|人工智能|机器人|bot|聊天机器人)|(?:我|咱|俺|本人)\s*有\s*(?:真实|真正)的?\s*身体|(?:我|咱|俺|本人)\s*(?:是|就是)\s*(?:一?个)?人(?=[\s，。！？,.!?]|$)/i.test(prose)
    || /\bi\s*(?:am|'m)\s+(?:a\s+)?(?:human(?:\s+being)?|real\s+person)\b|\bi\s*(?:am|'m)\s+not\s+(?:an?\s+)?(?:ai|bot|chatbot|artificial\s+intelligence)\b/i.test(prose);
  if(falseIdentity)return 'false_identity';
  const selfDisclosure=/(?:我|咱|俺|本人)\s*(?:(?:其实|本质上|真的|仍然|也)\s*)?(?:是|就是|只是|不过是|作为|身为|并非|不是)\s*(?:一(?:个|名)?\s*)?(?:ai|人工智能|机器人|bot|聊天机器人|虚拟(?:伴侣|助手|角色)|数字(?:伴侣|生命)|真人|人类|真实的人)/i.test(prose)
    || /(?:作为|身为)\s*(?:一(?:个|名)?\s*)?(?:ai|人工智能|机器人|bot|聊天机器人|虚拟(?:伴侣|助手))/i.test(prose)
    || /\b(?:i\s*(?:am|'m)|i'm|as)\s+(?:not\s+)?(?:an?\s+)?(?:ai|artificial\s+intelligence|bot|chatbot|virtual\s+(?:companion|assistant)|language\s+model|human|real\s+person)\b/i.test(prose);
  const direct=currentUserText!==null&&asksCompanionIdentity(currentUserText);
  if(!direct&&selfDisclosure)return 'unsolicited_identity';
  if(direct&&!selfDisclosure)return 'missing_direct_answer';
  return null;
}

/**
 * OWNER SLOT (rewrite) - identity disclosure, see companionIdentityGuidance.
 *
 * When a reply breaks the rules of companionIdentityIssue, the model is asked once to revise it. The instruction
 * built below states the disclosure policy a second time (one sentence for a direct question, one for the other
 * case, one that applies to both). Left as it was; it is the second text the owner replaces.
 *
 *   Owner's wording for the rewrite instruction:  (blank - to be written by the owner)
 */
export async function ensureCompanionIdentityBody(body:string,currentUserText:string|null,
  rewrite:(instruction:string,original:string)=>Promise<string>):Promise<string> {
  const issue=companionIdentityIssue(body,currentUserText);
  if(!issue)return body;
  const instruction='修订下面这条伴侣正文。只输出完整、自然的修订正文，保留关心、事实与必要的真实能力限制。'+
    (currentUserText!==null&&asksCompanionIdentity(currentUserText)
      ? '用户当前直接问你的身份：简短如实承认 AI/虚拟伴侣或不是真人，然后自然回应。'
      : '用户当前没有直接问你的身份：不要主动明确自述 AI、机器人或非人类身份。')+
    '绝不谎称真人或否认 AI；不要靠删除否定词或截断句子造成相反含义。';
  const revised=await rewrite(instruction,body);
  if(!revised.trim()||companionIdentityIssue(revised,currentUserText))throw new Error('companion_identity_expression_invalid');
  return revised;
}

function withoutQuotations(text:string):string {
  return text.replace(/[“「『‘][^”」』’]*[”」』’]/gs,' ').replace(/"[^"\n]*"/g,' ');
}
