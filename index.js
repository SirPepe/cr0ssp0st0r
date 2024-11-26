import { createStreamingAPIClient, createRestAPIClient } from "masto";
import { AtpAgent, RichText, AppBskyFeedPost } from "@atproto/api";
import { stripHtml } from "string-strip-html";
import { fail } from "@sirpepe/shed/error";
import { countGraphemes } from "@sirpepe/shed/string";
import storage from "node-persist";

const {
  STORAGE_DIR = fail("env.STORAGE_DIR not set"),
  AT_PROTO_SERVICE = fail("env.AT_PROTO_SERVICE not set"),
  AT_PROTO_IDENTIFIER = fail("env.AT_PROTO_IDENTIFIER not set"),
  AT_PROTO_PASSWORD = fail("env.AT_PROTO_PASSWORD not set"),
  MASTODON_INSTANCE_URL = fail("env.MASTODON_INSTANCE_URL not set"),
  MASTODON_ACCESS_TOKEN = fail("env.MASTODON_ACCESS_TOKEN not set"),
  MASTODON_ACCOUNT_ID = fail("env.MASTODON_ACCOUNT_ID not set"),
} = process.env;

await storage.init({ dir: STORAGE_DIR });

const agent = new AtpAgent({ service: AT_PROTO_SERVICE });

await agent.login({
  identifier: AT_PROTO_IDENTIFIER,
  password: AT_PROTO_PASSWORD,
});

function includeEvent(mastodonEvent) {
  const { payload, event } = mastodonEvent;
  if (
    // Skip everything that does not warrant a cross-post, like posts by others,
    // non-visible and muted posts, deletions etc.
    event !== "update" ||
    payload.visibility !== "public" ||
    payload.muted === true ||
    payload.account.id !== MASTODON_ACCOUNT_ID ||
    // Skip posts that contain mentions, because IDK, what else?
    payload.mentions.length > 0 ||
    // Skip replies that are not to our own threads
    (payload.inReplyToAccountId !== null &&
      payload.inReplyToAccountId !== MASTODON_ACCOUNT_ID)
  ) {
    return false;
  }
  return true;
}

// Mastodon delivers text as XHTML without any whitespace between tags. Simply
// stripping HTML tags eats the <br /> tags and paragraph boundaries that are
// needed to serve as line breaks. To deal with this, the function injects a few
// newlines and THEN strips all tags. Post length on Mastodon can be anything,
// while Bsky text length is limited to 300 graphemes. To deal with this, the
// function truncates text that is too long and inserts a URL to the source
// post.
function reformatText(mastodonStatus) {
  const { content, url, language } = mastodonStatus;
  const text = stripHtml(
    content.replaceAll(/<br\s?\/>/g, "\n").replaceAll("</p><p>", "\n\n")
  ).result;
  if (countGraphemes(text) > 300) {
    const maxGraphemeCount = 300 - url.length - 2;
    const wordSegmenter = new Intl.Segmenter(language, { granularity: "word" });
    let snippet = "";
    let addToSnippet = "";
    for (const { segment, isWordLike } of wordSegmenter.segment(text)) {
      addToSnippet += segment;
      if (isWordLike) {
        if (countGraphemes(snippet + addToSnippet) >= maxGraphemeCount) {
          return snippet + `… ${url}`;
        }
        snippet += addToSnippet;
        addToSnippet = "";
      }
    }
  }
  return text;
}

async function* getMastodonStatusStream() {
  const instance = await createRestAPIClient({
    url: MASTODON_INSTANCE_URL,
  }).v2.instance.fetch();
  const client = createStreamingAPIClient({
    streamingApiUrl: instance.configuration.urls.streaming,
    accessToken: MASTODON_ACCESS_TOKEN,
  });
  const subscription = client.user.subscribe();
  for await (const event of subscription) {
    if (includeEvent(event)) {
      // TODO: support media attachments that are not images
      if (event.payload.mediaAttachments.some(({ type }) => type !== "image")) {
        console.log("Skipping post due to non-image media attachments");
        continue;
      }
      yield event.payload;
    }
  }
}

// sources: { url: string }[]
async function transloadMastodonMediaToBsky(sources) {
  return await Promise.all(
    sources.map(async ({ url }) => {
      try {
        const downloadResponse = await fetch(url);
        if (!downloadResponse.ok) {
          throw new Error(`Download returned status ${downloadResponse.code}`);
        }
        const uploadResponse = await agent.uploadBlob(
          await downloadResponse.blob()
        );
        if (!uploadResponse.success) {
          throw new Error(`Upload not successful`, { uploadResponse });
        }
        return uploadResponse.data.blob;
      } catch (error) {
        throw new Error(`Transloading ${url} failed:`, { cause: error });
      }
    })
  );
}

// Non-image attachments are currently filtered out before this function ever
// gets called
async function mastodonMediaToBskyEmbeds({ mediaAttachments }) {
  const blobs = await transloadMastodonMediaToBsky(mediaAttachments);
  return {
    $type: "app.bsky.embed.images",
    images: mediaAttachments.map((attachment, index) => ({
      alt: attachment.description,
      image: blobs[index],
      aspectRatio: {
        width: attachment.meta.original.width,
        height: attachment.meta.original.height,
      },
    })),
  };
}

async function mastodonCardToBskyEmbed({ card }) {
  const embed = {
    $type: "app.bsky.embed.external",
    external: {
      uri: card.url,
      title: card.title,
      description: card.description,
    },
  };
  // TODO: does this work?
  if (card.image) {
    const [blob] = await transloadMastodonMediaToBsky([{ url: card.image }]);
    embed.external.blob = blob.original;
  }
  return embed;
}

async function mastodonStatusToBskyPost(mastodonStatus) {
  const rt = new RichText({ text: reformatText(mastodonStatus) });
  await rt.detectFacets(agent);
  const post = {
    $type: "app.bsky.feed.post",
    text: rt.text,
    facets: rt.facets,
    langs: [mastodonStatus.language],
    createdAt: mastodonStatus.createdAt,
  };
  if (mastodonStatus.inReplyToId) {
    const parent = await storage.getItem(mastodonStatus.inReplyToId);
    if (parent.bsky) {
      post.reply = {
        parent: parent.bsky.post,
        root: parent.bsky.root || parent.bsky.post,
      };
    }
  }
  // I guess there can be only one embed per post?
  if (mastodonStatus.mediaAttachments.length > 0) {
    post.embed = await mastodonMediaToBskyEmbeds(mastodonStatus);
  } else if (mastodonStatus.card) {
    post.embed = await mastodonCardToBskyEmbed(mastodonStatus);
  }
  const validationResult = AppBskyFeedPost.validateRecord(post);
  if (validationResult.success) {
    return post;
  } else {
    throw new Error(`Failed to create bsky post: ${validationResult.error}`, {
      cause: {
        validationResult,
        post,
      },
    });
  }
}

console.log("Ready to cross some posts 💪");

for await (const mastodonStatus of getMastodonStatusStream()) {
  console.log(mastodonStatus);
  try {
    const bskyPost = await mastodonStatusToBskyPost(mastodonStatus);
    const posted = await agent.post(bskyPost);
    try {
      await storage.setItem(mastodonStatus.id, {
        bsky: {
          post: posted,
          root: bskyPost.reply?.root ?? null,
        },
      });
      console.log("Posted & saved", { mastodonStatus, bskyPost, posted });
    } catch (error) {
      console.error("Cross-posting worked, but result storage failed:", error);
    }
  } catch (error) {
    await storage.setItem(mastodonStatus.id, { bsky: null });
    console.error("Failure during cross-posting:", error);
  }
}
