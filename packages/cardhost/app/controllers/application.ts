import Controller from '@ember/controller';
import { inject as service } from '@ember/service';
import OverlaysService from '../services/overlays';
import CardLocalStorageService from '../services/card-local-storage';
//@ts-ignore
import ENV from '@cardstack/cardhost/config/environment';

const { deviceCardsOnly } = ENV;

export default class ApplicationController extends Controller {
  @service overlays!: OverlaysService;
  @service cardLocalStorage!: CardLocalStorageService;

  constructor() {
    super(...arguments);
    if (deviceCardsOnly) {
      // If deviceCardsOnly env is true, associate cards with a semi-random
      // string saved in local storage, so that test users only see
      // their own cards.
      this.cardLocalStorage.setDevice();
    }
  }
}
