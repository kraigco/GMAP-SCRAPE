# Cold outreach — v2 (email campaign)

Supersedes v1. v1 was written as a single letter; v2 is written for a bulk send
through an ESP (Brevo, Sender, Mailchimp), which changes three things: every
slot needs a fallback, the list needs a segmentation rule, and the footer needs
to satisfy both CAN-SPAM and the ESP's own contract.

Every draft records the template version that produced it, so a change in reply
rate can be traced to a change in wording rather than guessed at.

---

## 0. Read this before importing a list

**Only send to rows where `hook` is non-empty.**

This is the segmentation rule and it is not negotiable. A row with an empty
`hook` has an empty one because the audit found nothing true to say about that
business — `hook_basis` records which: `no gap found`, `not audited`, or
`robots.txt disallowed`. Sending to those rows means writing a generic email,
and a generic email is where invented problems come from.

On the current Philadelphia list that is **93 of 216 rows**. The other 123 are
not a lower-priority segment to warm up later. They are businesses we have
nothing to say to yet. Audit more, or find a different angle, but do not put
them in this campaign.

In the ESP, build the segment as `hook is not empty`. In the sheet, filter
column AC.

**On the choice of platform.** CAN-SPAM makes this send *legal* — commercial
email to US recipients is permitted with accurate headers, a working opt-out and
a postal address. That is not the same as *permitted by your ESP*. Mailchimp's
terms require opt-in consent and prohibit scraped or purchased lists; a Google
Maps harvest is neither opt-in nor purchased, and accounts do get terminated for
it, usually mid-campaign. Brevo and Sender are more tolerant of cold B2B but
still bind you to their acceptable-use policy. Tools built for cold outreach —
Instantly, Smartlead, Lemlist — send from your own dedicated inboxes with
warm-up, which is different infrastructure with different rules. Pick with that
in mind, and read the acceptable-use policy of whichever you pick before
uploading 93 scraped addresses to it.

---

## 1. What makes this email work

**It opens with something we measured about them.** Not about us. The reader
keeps going because sentence one is true, specific, and about their business.

**It creates urgency from evidence, never from invention.** The pressure in this
letter comes from a number the reader can check, set against their competitors'
numbers. That is real FOMO and it survives scrutiny. Manufactured urgency — a
deadline that is not real, a discount that does not exist, "your competitors are
already ahead" with nothing behind it — does the opposite: it marks the sender
as someone who did not actually look.

**It sounds like one person wrote it.** Contractions, a real name, a real phone
number. No "we hope this email finds you well", no "I wanted to reach out", no
"in today's digital landscape". A cold email that reads like a template gets
answered like a template.

**It asks for something small.** A reply, not a meeting.

---

## 2. Subject lines — one per measured gap

Lower case. No exclamation marks. No "Quick question". It should read like a
note from a person who noticed something, because that is what it is.

| Measured gap | Subject |
|---|---|
| site did not load | `{{business_name}} — your site didn't load on {{checked_on}}` |
| no website listed | `{{reviews}} reviews, no website` |
| slow | `{{business_name}} takes {{seconds}} seconds to load` |
| not mobile-friendly | `{{business_name}} on a phone` |
| no HTTPS | `browsers are flagging {{business_name}}` |

**Never test a subject line against a claim the body cannot support.** The
subject is a promise about what the first sentence contains.

---

## 3. Body

Plain text. No images, no tracking pixel dressed up as a logo, no signature
card. Under 150 words, so it reads on a phone without scrolling.

```
Hi {{first_name | fallback: "there"}},

{{HOOK}}

{{BENCHMARK}}

I'm {{sender_name}} — I run Rekreate Digital. We build the site and the
systems behind it, hand you the keys, and stay on call when something
breaks. You own it outright. That's the whole model.

I'm not asking for a meeting. If you want it, reply "send it" and I'll
write up everything we found on {{business_name}} — what we checked,
what we measured, and what I'd fix first. No charge, no call, and I
won't follow up unless you ask me to.

{{sender_name}}
{{sender_title}}, Rekreate Digital
{{sender_phone}}
```

### The BENCHMARK slot — where the FOMO comes from

One sentence, chosen by the same measured gap that chose the hook, comparing
this business to the audited corpus for its own market and niche. Every number
in it is one we measured ourselves and can show them.

| Gap | Benchmark sentence |
|---|---|
| site did not load | `We checked {{corpus_n}} property management companies across {{market}}. {{corpus_up}} had a site that loaded. Yours was one of the {{corpus_down}} that didn't.` |
| slow | `Across the {{corpus_up}} sites in {{market}} that loaded, the median was {{corpus_median_ttfb}}. Yours was {{seconds}}.` |
| not mobile-friendly | `{{corpus_viewport_ok}} of the {{corpus_up}} sites we checked in {{market}} render properly on a phone. Yours is one of the {{corpus_viewport_bad}} that don't.` |
| no HTTPS | `{{corpus_https_ok}} of the {{corpus_up}} sites we checked in {{market}} are on HTTPS. Yours is one of the {{corpus_https_bad}} that aren't.` |
| no website listed | *(no benchmark — the hook is already the whole argument)* |

**These values are computed from the corpus, never typed by hand.**
`computeCorpus()` in `src/pitch/benchmark.ts` folds the audited rows into the
counts, and `benchmarkFor()` picks the sentence. They change every time the list
is re-audited, and a stale number in a cold email is exactly the thing a
prospect will check. Recompute per market and per niche — a Philadelphia
property-management benchmark must never be sent to a Camden roofer.

For the current Philadelphia property-management list, as audited:

| Slot | Value |
|---|---|
| `{{corpus_n}}` | 215 |
| `{{corpus_up}}` | 141 |
| `{{corpus_down}}` | 74 |
| `{{corpus_median_ttfb}}` | 0.6 seconds |
| `{{corpus_viewport_ok}}` / `{{corpus_viewport_bad}}` | 137 / 4 |
| `{{corpus_https_ok}}` / `{{corpus_https_bad}}` | 138 / 3 |

215, not the 216 rows in the file: one site is disallowed by its own robots.txt,
so it was never audited and cannot sit in a denominator. That single row is the
difference between a number we measured and a number we rounded up, which is
the whole distinction this template rests on.

Note what is *not* in that table: a "no contact form" benchmark. The audit found
a contact form on 97 of the 141 reachable sites and could not determine it
either way on the other 44. `unknown` is not a gap, so there is no sentence to
write. Do not turn 44 into "44 firms have no way to contact them".

---

## 4. Footer — legally required, not polish

```
Rekreate Digital
{{postal_address}}

You're getting this because {{business_name}} is listed publicly in
Greater Philadelphia and its website is publicly reachable. If you'd
rather not hear from me, {{unsubscribe_link}} and I'll remove you
permanently — one click, no reply needed.
```

Three requirements, all of them law under CAN-SPAM and all of them enforced:

1. **A real postal address.** A street address or a registered PO box. Not the
   Manila office unless that is the address you will stand behind.
2. **A working opt-out**, honoured within 10 business days — in practice,
   immediately. Use the ESP's native unsubscribe link so suppression is
   automatic; a "reply no" instruction depends on a human remembering.
3. **Accurate From, Reply-To and subject.** The From name is a real person at a
   domain Rekreate controls.

Say plainly why they are receiving it. It costs one sentence, it is true, and it
is most of the difference between a cold email and a spam complaint.

---

## 5. Slots

| Slot | Filled by | Status |
|---|---|---|
| `{{HOOK}}` | `src/pitch/hooks.ts`, per business | **built** |
| `{{BENCHMARK}}` | `src/pitch/benchmark.ts`, from the audited corpus | **built, not yet wired to the sheet** |
| `{{business_name}}` `{{reviews}}` `{{checked_on}}` `{{seconds}}` | the audit | **built** |
| `{{first_name}}` | not collected — always falls back to "there" | **fallback only** |
| `{{sender_name}}` `{{sender_title}}` `{{sender_phone}}` | whoever the reply goes to | **needs deciding** |
| `{{postal_address}}` | legal requirement — a real address | **needs deciding** |
| `{{unsubscribe_link}}` | the ESP's native token | **per platform** |

Every slot needs an ESP fallback. A merge tag that renders empty produces
`Hi ,` — which tells the reader exactly how the email was made.

---

## 6. Still no client is named

There is no case-study line, and adding one is a decision to be taken
deliberately, not a gap to be filled. Naming a client in cold outreach sends
their name to strangers who never asked to hear it, and the sentence a prospect
is most likely to check is the one that costs most if it overstates by a word.

The letter carries its credibility differently: it opens with something specific
and true about *their* business that we went and measured, and backs it with a
number from a corpus we built ourselves. A stranger who knows one real thing
about you is more convincing than a stranger with a reference.

---

## 7. Banned moves

These are the edits this template will drift toward under pressure to "make it
convert". Each one trades a reply today against the reputation that earns
replies next quarter.

- **No invented urgency.** No deadline that is not real, no "limited slots" that
  are not limited, no discount that expires. If capacity genuinely is limited,
  say the true number; otherwise say nothing.
- **No claim about their revenue, ranking, traffic or lost customers.** We
  cannot measure any of it. They know their own numbers and we do not.
- **No "I was looking at your website and…"** unless we were. The hook says what
  we checked and when, and that is verifiable.
- **No turning `unknown` into a problem.** The audit distinguishes "we found no
  contact form" from "we could not tell". Only the first is a gap.
- **No sending to an empty hook.** See section 0.
- **No urgency word carrying the sentence.** "Urgent", "act now", "don't miss
  out" and "last chance" are what an email says when it has no measurement to
  offer. This one has a measurement.
