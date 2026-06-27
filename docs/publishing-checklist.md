# Publishing Checklist

Use this checklist when an AI agent prepares a post for release.

## Draft Review

- [ ] Title is specific.
- [ ] Description is 40-120 characters.
- [ ] The post has one clear thesis.
- [ ] The opening explains why this topic matters.
- [ ] The article contains concrete examples.
- [ ] The conclusion is not generic.
- [ ] No internal prompt/writing brief/TODO remains.

## Metadata

- [ ] `author: F3D`
- [ ] `pubDatetime` is correct.
- [ ] `tags` contains `release` only after approval.
- [ ] `tags` contains at least one public tag.
- [ ] `draft` is absent or `false` for release.

## Images

- [ ] All images have useful alt text.
- [ ] Local images are uploaded via `npm run post:images`.
- [ ] No screenshot leaks private information.
- [ ] Images render in local preview.

## Commands

```bash
npm run post:check
npm run build
```

## Final Review Packet

Before publishing, the agent should report:

- post path
- title
- tags
- public URL path
- assumptions
- validation result
