# Cold outreach — v1

Version this file. Every draft records which template version produced it, so a
change in reply rate can be traced to a change in wording rather than guessed at.

## Principles this template is built on

**Short enough to read on a phone in ten seconds.** A cold email that needs
scrolling is a cold email that gets archived. Six sentences, no images, no
signature graphics, plain text.

**Lead with the finding, not with us.** The first sentence is about their
business and is something we measured. Nobody opens a cold email to learn who we
are; they keep reading because the first line was about them and was true.

**One small ask.** "Book a call" is a big ask from a stranger. Offering
something that costs them nothing and requires no meeting converts better and
loses nothing when ignored.

**A real opt-out, and a postal address.** CAN-SPAM applies to these sends — US
recipients, commercial content. An accurate sender, a working opt-out and a
physical address are legal requirements, not polish. Honour the opt-out on the
first request, permanently.

---

## Subject line — customized per finding

| Their gap | Subject |
|---|---|
| no website, established | `{{reviews}} reviews, no website` |
| no website, new firm | `{{businessName}} — no website on your listing` |
| site down | `your site was down on {{checkedOn}}` |
| not mobile-friendly | `{{businessName}} on a phone` |
| no HTTPS | `browsers are flagging your site` |
| slow | `{{seconds}} seconds before your site appears` |

Lower case, no exclamation marks, no "Quick question". It should read like a note
from a person who noticed something, because that is what it is.

---

## Body

```
Hi {{businessName}},

{{HOOK}}

We're Rekreate. We build and run the website — you own it outright,
and we keep it working.

Want the full list of what we found on your listing? Reply "send it"
and I'll write it up — no charge, no call.

{{senderName}}
Rekreate Digital
{{postalAddress}}

Not interested? Reply "no" and I won't write again.
```

---

## The slots

| Slot | Filled by | Status |
|---|---|---|
| `{{HOOK}}` | the audit, per business — its measured gap and its niche | **built** |
| `{{businessName}}` | Google listing | **built** |
| `{{reviews}}` `{{checkedOn}}` `{{seconds}}` | the audit | **built** |
| `{{senderName}}` | whoever the reply goes to | **needs deciding** |
| `{{postalAddress}}` | legal requirement — a real address | **needs deciding** |

### No client is named

There is no case-study line. Naming a client in cold outreach means their name
travels to strangers who never asked to hear it, and the sentence a prospect is
most likely to check is the one that costs most if it overstates by a word.

The letter carries its credibility differently: it opens with something specific
and true about *their* business that we went and measured. A stranger who knows
one real thing about you is more convincing than a stranger with a reference.

---

## What this template deliberately does not do

**No claim about their revenue, ranking or traffic.** We cannot measure any of
it, so anything we said about it would be invented — and a prospect knows their
own numbers better than we ever will.

**No "I was looking at your website and…"** unless we actually were. The hook
says what we checked and when.

**No pressure and no false deadline.** They are a stranger who did not ask to
hear from us. The only reason this is worth their attention is that it contains
one true, useful, specific observation.
