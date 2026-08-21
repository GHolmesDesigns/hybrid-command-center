import { describe, expect, it } from 'vitest';
import {
  normalizePublishVariant,
  publishEffectiveCaption,
  publishOverriddenFields,
  publishVariantFieldSupported,
  publishVariantFieldsFor,
  publishVariantIsEmpty,
  publishVariantLayers,
  publishVariantPlacements,
  resolvePublishContent,
  PUBLISH_SYNTHETIC_MEDIA_DISCLOSURE,
  PUBLISH_VARIANT_FIELDS,
  type PublishVariantBase,
  type PublishVariantRecord,
} from './publish-variants.ts';
import { PUBLISH_CAPABILITIES } from './publish-capabilities.ts';

/**
 * The inheritance, exercised with no React, no server, and no database in sight.
 *
 * That is the point of the module and of this file: the order base -> platform -> account is the
 * rule the whole card rests on, and it is checked here as arithmetic rather than through a rendered
 * form or an HTTP round trip, both of which can pass while the order is wrong.
 */

const base: PublishVariantBase = {
  caption: 'Clarity as competitive advantage',
  mediaUrls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
  postKind: 'POST',
};

describe('base -> platform -> account', () => {
  it('reads the post when no layer says otherwise, and says so in every source', () => {
    const resolved = resolvePublishContent(base);
    expect(resolved.caption).toBe(base.caption);
    expect(resolved.mediaUrls).toEqual(base.mediaUrls);
    expect(resolved.postKind).toBe('POST');
    expect(resolved.title).toBeUndefined();
    expect(resolved.discloseSyntheticMedia).toBe(false);
    // Total rather than partial: every field is answered, and "the post" is an answer.
    expect(Object.keys(resolved.sources).sort()).toEqual([...PUBLISH_VARIANT_FIELDS].sort());
    expect(publishOverriddenFields(resolved)).toEqual([]);
  });

  it('lets the platform layer win over the post and the account layer win over both', () => {
    const resolved = resolvePublishContent(base, {
      platform: { caption: 'The platform caption', title: 'A platform title' },
      account: { caption: 'The account caption' },
    });
    expect(resolved.caption).toBe('The account caption');
    expect(resolved.sources.caption).toBe('ACCOUNT');
    // The account layer is silent about the title, so the platform's survives rather than being
    // wiped by a layer that never mentioned it.
    expect(resolved.title).toBe('A platform title');
    expect(resolved.sources.title).toBe('PLATFORM');
    expect(resolved.sources.mediaUrls).toBe('BASE');
    expect(publishOverriddenFields(resolved)).toEqual(['caption', 'title']);
  });

  it('keeps every field independent, in the one order', () => {
    const resolved = resolvePublishContent(base, {
      platform: {
        mediaUrls: ['https://cdn.example.com/b.jpg'],
        postKind: 'REEL',
        discloseSyntheticMedia: true,
      },
      account: { discloseSyntheticMedia: false, firstComment: 'The link lives here.' },
    });
    expect(resolved.mediaUrls).toEqual(['https://cdn.example.com/b.jpg']);
    expect(resolved.postKind).toBe('REEL');
    // An account layer can turn off what the platform turned on: `false` is a value, not silence.
    expect(resolved.discloseSyntheticMedia).toBe(false);
    expect(resolved.sources.discloseSyntheticMedia).toBe('ACCOUNT');
    expect(resolved.firstComment).toBe('The link lives here.');
  });

  it('never lets a resolved media list alias the post or a layer', () => {
    const layer = { mediaUrls: ['https://cdn.example.com/a.jpg'] };
    const resolved = resolvePublishContent(base, { platform: layer });
    resolved.mediaUrls.push('https://cdn.example.com/c.jpg');
    expect(layer.mediaUrls).toEqual(['https://cdn.example.com/a.jpg']);
    expect(base.mediaUrls).toHaveLength(2);
  });
});

describe('what a layer means by empty', () => {
  it('drops a blank text field so clearing a field restores the post', () => {
    const normalized = normalizePublishVariant({
      caption: '   ',
      title: '',
      firstComment: '  A real reply  ',
    });
    expect(normalized.caption).toBeUndefined();
    expect(normalized.title).toBeUndefined();
    expect(normalized.firstComment).toBe('A real reply');
    expect(resolvePublishContent(base, { platform: normalized }).caption).toBe(base.caption);
  });

  it('keeps an empty media selection, which is a platform that receives none', () => {
    const normalized = normalizePublishVariant({ mediaUrls: [] });
    expect(normalized.mediaUrls).toEqual([]);
    const resolved = resolvePublishContent(base, { platform: normalized });
    expect(resolved.mediaUrls).toEqual([]);
    expect(resolved.sources.mediaUrls).toBe('PLATFORM');
  });

  it('calls a layer with nothing left in it empty, so nothing stores it', () => {
    expect(publishVariantIsEmpty(normalizePublishVariant({ caption: '  ' }))).toBe(true);
    expect(publishVariantIsEmpty(normalizePublishVariant({ mediaUrls: [] }))).toBe(false);
    expect(publishVariantIsEmpty({ discloseSyntheticMedia: false })).toBe(false);
  });
});

describe('finding the layers for one target', () => {
  const variants: PublishVariantRecord[] = [
    { platform: 'twitter', accountId: null, caption: 'X, from the platform layer' },
    { platform: 'twitter', accountId: 7, caption: 'X, for account 7' },
    { platform: 'linkedin', accountId: null, caption: 'LinkedIn' },
  ];

  it('takes the platform layer alone when no account is named', () => {
    expect(publishVariantLayers(variants, 'twitter')).toEqual({
      platform: { caption: 'X, from the platform layer' },
    });
  });

  it('takes only the named account, never another account on the same platform', () => {
    expect(publishVariantLayers(variants, 'twitter', 7).account).toEqual({
      caption: 'X, for account 7',
    });
    expect(publishVariantLayers(variants, 'twitter', 8).account).toBeUndefined();
  });

  it('answers with nothing for a platform that has no layer at all', () => {
    expect(publishVariantLayers(variants, 'youtube', 3)).toEqual({});
  });
});

describe('the synthetic-media disclosure', () => {
  it('writes itself into the caption where the platform has no field, exactly once', () => {
    const content = { caption: 'A whiteboard explainer', discloseSyntheticMedia: true };
    const first = publishEffectiveCaption(content, PUBLISH_CAPABILITIES.youtube);
    expect(first).toBe(`A whiteboard explainer\n\n${PUBLISH_SYNTHETIC_MEDIA_DISCLOSURE}`);
    // Already disclosed by hand: appending a second copy would be its own kind of wrong.
    expect(
      publishEffectiveCaption({ ...content, caption: first }, PUBLISH_CAPABILITIES.youtube),
    ).toBe(first);
  });

  it('leaves the caption alone when nothing was disclosed, or where a provider field exists', () => {
    expect(
      publishEffectiveCaption(
        { caption: 'Plain', discloseSyntheticMedia: false },
        PUBLISH_CAPABILITIES.youtube,
      ),
    ).toBe('Plain');
    expect(
      publishEffectiveCaption(
        { caption: 'Plain', discloseSyntheticMedia: true },
        { ...PUBLISH_CAPABILITIES.youtube, syntheticMediaDisclosure: 'PROVIDER_FIELD' },
      ),
    ).toBe('Plain');
  });
});

describe('which fields a platform will carry', () => {
  it('offers a first comment on X and nowhere else', () => {
    expect(publishVariantFieldSupported('firstComment', PUBLISH_CAPABILITIES.twitter)).toBe(true);
    expect(publishVariantFieldSupported('firstComment', PUBLISH_CAPABILITIES.linkedin)).toBe(false);
  });

  it('offers a title exactly where the contract records one', () => {
    expect(publishVariantFieldSupported('title', PUBLISH_CAPABILITIES.youtube)).toBe(true);
    expect(publishVariantFieldSupported('title', PUBLISH_CAPABILITIES.bluesky)).toBe(false);
  });

  it('offers a role exactly where the provider names one, verified or not', () => {
    // Composable, not deliverable. Post Bridge names a cover for Instagram and a thumbnail for
    // YouTube, so those two are the only places a role can be chosen at all — and whether either
    // one is *sent* is `publishRoleDelivers`, which `publish-variant-media.test.ts` pins to the
    // capability flags.
    expect(publishVariantFieldSupported('coverImage', PUBLISH_CAPABILITIES.instagram)).toBe(true);
    expect(publishVariantFieldSupported('thumbnail', PUBLISH_CAPABILITIES.youtube)).toBe(true);
    expect(publishVariantFieldSupported('thumbnail', PUBLISH_CAPABILITIES.instagram)).toBe(false);
    expect(publishVariantFieldSupported('coverImage', PUBLISH_CAPABILITIES.youtube)).toBe(false);
    for (const capability of Object.values(PUBLISH_CAPABILITIES)) {
      if (capability.platform === 'instagram' || capability.platform === 'youtube') continue;
      expect(publishVariantFieldSupported('coverImage', capability)).toBe(false);
      expect(publishVariantFieldSupported('thumbnail', capability)).toBe(false);
    }
  });

  it('offers a placement only where there is more than one shape to choose', () => {
    expect(publishVariantPlacements(PUBLISH_CAPABILITIES.instagram)).toEqual([
      'POST',
      'CAROUSEL',
      'REEL',
      'STORY',
    ]);
    expect(publishVariantFieldSupported('postKind', PUBLISH_CAPABILITIES.instagram)).toBe(true);
    // Pinterest takes a standard post and nothing else, so there is no placement to offer.
    expect(publishVariantPlacements(PUBLISH_CAPABILITIES.pinterest)).toEqual(['POST']);
    expect(publishVariantFieldSupported('postKind', PUBLISH_CAPABILITIES.pinterest)).toBe(false);
  });

  it('lists the whole field set for a platform in one agreed order', () => {
    expect(publishVariantFieldsFor(PUBLISH_CAPABILITIES.twitter)).toEqual([
      'caption',
      'mediaUrls',
      'postKind',
      'firstComment',
      'discloseSyntheticMedia',
    ]);
    expect(publishVariantFieldsFor(PUBLISH_CAPABILITIES.youtube)).toEqual([
      'caption',
      'mediaUrls',
      'postKind',
      'title',
      'discloseSyntheticMedia',
      'thumbnail',
    ]);
    // Instagram is the other half of the pair: a cover and no thumbnail, which is exactly what the
    // provider names for it.
    expect(publishVariantFieldsFor(PUBLISH_CAPABILITIES.instagram)).toEqual([
      'caption',
      'mediaUrls',
      'postKind',
      'discloseSyntheticMedia',
      'coverImage',
    ]);
  });
});
