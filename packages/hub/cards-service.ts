import { Session } from './session';
import { UnsavedCard, Card, CardId, canonicalURLToCardId } from './card';
import { CARDSTACK_PUBLIC_REALM } from './realm';
import CardstackError from './error';
import { myOrigin } from './origin';
import { search as scaffoldSearch, get as scaffoldGet, validate } from './scaffolding';
import { getOwner, inject } from './dependency-injection';
import { SingleResourceDoc } from 'jsonapi-typescript';
import { Query } from './query';
import { ResponseMeta } from './pgsearch/pgclient';

export default class CardsService {
  pgclient = inject('pgclient');

  as(session: Session) {
    return new ScopedCardService(this, session);
  }
}

export class ScopedCardService {
  constructor(private cards: CardsService, private session: Session) {}

  instantiate(jsonapi: SingleResourceDoc): Card {
    return new Card(jsonapi);
  }

  async create(realm: string, doc: SingleResourceDoc): Promise<Card> {
    let realmCard = await this.getRealm(realm);
    let writerFactory = await realmCard.loadFeature('writer');
    if (!writerFactory) {
      throw new CardstackError(`realm "${realm}" is not writable`, {
        status: 403,
      });
    }
    let writer = await getOwner(this.cards).instantiate(writerFactory, realmCard);
    let card: UnsavedCard = new UnsavedCard(doc, realm);
    await validate(null, card, realmCard);

    let upstreamIdToWriter = card.upstreamId;
    let { saved, id: upstreamIdFromWriter } = await writer.create(
      this.session,
      await card.asUpstreamDoc(),
      upstreamIdToWriter
    );
    if (upstreamIdToWriter && upstreamIdFromWriter !== upstreamIdToWriter) {
      throw new CardstackError(`Writer plugin for realm ${realm} tried to change a localId it's not allowed to change`);
    }
    card.localId = typeof upstreamIdFromWriter === 'object' ? upstreamIdFromWriter.localId : upstreamIdFromWriter;
    let savedCard = card.asSavedCard();
    savedCard.patch(saved.jsonapi);

    let batch = this.cards.pgclient.beginCardBatch(this);
    await batch.save(savedCard);
    await batch.done();

    return savedCard;
  }

  async search(query: Query): Promise<{ cards: Card[]; meta: ResponseMeta }> {
    let cards = await scaffoldSearch(query);
    if (cards) {
      return { cards, meta: { page: { total: cards.length } } };
    }

    let { cards: foundCards, meta } = await this.cards.pgclient.search(this, query);
    return { cards: foundCards, meta };
  }

  async get(id: CardId): Promise<Card>;
  async get(canonicalURL: string): Promise<Card>;
  async get(idOrURL: CardId | string): Promise<Card> {
    // this exists to throw if there's no such realm. We're not using the return
    // value yet but we will onc we implement custom searchers and realm grants.
    let id;
    if (typeof idOrURL === 'string') {
      id = canonicalURLToCardId(idOrURL);
    } else {
      id = idOrURL;
    }
    await this.getRealm(id.realm);
    let card = await scaffoldGet(id);
    if (card) {
      return card;
    }
    // TODO dont create a scoped card service here
    return await this.cards.pgclient.get(this, id);
  }

  private async getRealm(realm: string): Promise<Card> {
    // This searches by realm and localId. Even though it doesn't search by
    // originalRealm, it's unique because of the special property that Realm
    // cards have that their localId contains the complete URL to the realm. So
    // localIds created on different hubs will never collide.
    //
    // We don't necessarily know the originalRealm we're looking for because we
    // don't know whose meta realm this realm was originally created in.
    let { cards: realms } = await this.cards.as(Session.INTERNAL_PRIVILEGED).search({
      filter: {
        type: { realm: CARDSTACK_PUBLIC_REALM, localId: 'realm' },
        eq: {
          // the special meta-realm on each origin has restrictive but not
          // entirely closed off permissions that let users create / update /
          // delete their own Realm cards. The set of relam cards in the
          // meta-realm determines all the realms this hub (origin) knows
          // about. Some of the realms in here can live on other origins, and
          // that's fine.
          realm: `${myOrigin}/api/realms/meta`,
          'local-id': realm,
        },
      },
    });

    if (realms.length === 0) {
      throw new CardstackError(`no such realm`, { status: 400 });
    }
    return realms[0];
  }
}

declare module '@cardstack/hub/dependency-injection' {
  interface KnownServices {
    cards: CardsService;
  }
}
