import Stripe from 'stripe';
import debug from 'debug';
import crypto from 'crypto';
import { isEmail, isNumeric } from 'validator';

import {
  durationKeysConfig,
  donationOneTimeConfig,
  donationSubscriptionConfig
} from '../../../config/donation-settings';
import keys from '../../../config/secrets';

const log = debug('fcc:boot:donate');

export default function donateBoot(app, done) {
  let stripe = false;
  const { User } = app.models;
  const api = app.loopback.Router();
  const donateRouter = app.loopback.Router();

  const subscriptionPlans = Object.keys(
    donationSubscriptionConfig.plans
  ).reduce(
    (prevDuration, duration) =>
      prevDuration.concat(
        donationSubscriptionConfig.plans[duration].reduce(
          (prevAmount, amount) =>
            prevAmount.concat({
              amount: amount,
              interval: duration,
              product: {
                name: `${
                  donationSubscriptionConfig.duration[duration]
                } Donation to freeCodeCamp.org - Thank you ($${amount / 100})`,
                metadata: {
                  /* eslint-disable camelcase */
                  sb_service: `freeCodeCamp.org`,
                  sb_tier: `${
                    donationSubscriptionConfig.duration[duration]
                  } $${amount / 100} Donation`
                  /* eslint-enable camelcase */
                }
              },
              currency: 'usd',
              id: `${donationSubscriptionConfig.duration[
                duration
              ].toLowerCase()}-donation-${amount}`
            }),
          []
        )
      ),
    []
  );

  function validStripeForm(amount, duration, email) {
    return isEmail('' + email) &&
      isNumeric('' + amount) &&
      durationKeysConfig.includes(duration) &&
      duration === 'onetime'
      ? donationOneTimeConfig.includes(amount)
      : donationSubscriptionConfig.plans[duration];
  }

  function connectToStripe() {
    return new Promise(function(resolve) {
      // connect to stripe API
      stripe = Stripe(keys.stripe.secret);
      // parse stripe plans
      stripe.plans.list({}, function(err, stripePlans) {
        if (err) {
          throw err;
        }
        const requiredPlans = subscriptionPlans.map(plan => plan.id);
        const availablePlans = stripePlans.data.map(plan => plan.id);
        if (process.env.STRIPE_CREATE_PLANS === 'true') {
          requiredPlans.forEach(requiredPlan => {
            if (!availablePlans.includes(requiredPlan)) {
              createStripePlan(
                subscriptionPlans.find(plan => plan.id === requiredPlan)
              );
            }
          });
        } else {
          log(`Skipping plan creation`);
        }
      });
      resolve();
    });
  }

  function createStripePlan(plan) {
    log(`Creating subscription plan: ${plan.product.name}`);
    stripe.plans.create(plan, function(err) {
      if (err) {
        log(err);
      }
      log(`Created plan with plan id: ${plan.id}`);
      return;
    });
  }

  function createStripeDonation(req, res) {
    const { user, body } = req;

    if (!user || !body) {
      return res
        .status(500)
        .send({ error: 'User must be signed in for this request.' });
    }

    const {
      amount,
      duration,
      token: { email, id }
    } = body;

    if (!validStripeForm(amount, duration, email)) {
      return res.status(500).send({
        error: 'The donation form had invalid values for this submission.'
      });
    }

    let donatingUser = {};
    let donation = {
      email,
      amount,
      duration,
      provider: 'stripe',
      startDate: new Date(Date.now()).toISOString()
    };

    const createCustomer = user => {
      donatingUser = user;
      return stripe.customers.create({
        email,
        card: id
      });
    };

    const createSubscription = customer => {
      donation.customerId = customer.id;
      return stripe.subscriptions.create({
        customer: customer.id,
        items: [
          {
            plan: `${donationSubscriptionConfig.duration[
              duration
            ].toLowerCase()}-donation-${amount}`
          }
        ]
      });
    };

    const createOneTimeCharge = customer => {
      donation.customerId = customer.id;
      return stripe.charges.create({
        amount: amount,
        currency: 'usd',
        customer: customer.id
      });
    };

    const createAsyncUserDonation = () => {
      donatingUser
        .createDonation(donation)
        .toPromise()
        .catch(err => {
          throw new Error(err);
        });
    };

    return Promise.resolve(user)
      .then(nonDonatingUser => {
        const { isDonating } = nonDonatingUser;
        if (isDonating) {
          throw {
            message: `User already has active donation(s).`,
            type: 'AlreadyDonatingError'
          };
        }
        return nonDonatingUser;
      })
      .then(createCustomer)
      .then(customer => {
        return duration === 'onetime'
          ? createOneTimeCharge(customer).then(charge => {
              donation.subscriptionId = 'one-time-charge-prefix-' + charge.id;
              return res.send(charge);
            })
          : createSubscription(customer).then(subscription => {
              donation.subscriptionId = subscription.id;
              return res.send(subscription);
            });
      })
      .then(createAsyncUserDonation)
      .catch(err => {
        if (
          err.type === 'StripeCardError' ||
          err.type === 'AlreadyDonatingError'
        ) {
          return res.status(402).send({ error: err.message });
        }
        return res
          .status(500)
          .send({ error: 'Donation failed due to a server error.' });
      });
  }

  function createStripeDonationYearEnd(req, res) {
    const { user, body } = req;

    const {
      amount,
      duration,
      token: { email, id }
    } = body;

    if (amount < 1 || duration !== 'onetime' || !isEmail(email)) {
      return res.status(500).send({
        error: 'The donation form had invalid values for this submission.'
      });
    }

    const fccUser = user
      ? Promise.resolve(user)
      : new Promise((resolve, reject) =>
          User.findOrCreate(
            { where: { email } },
            { email },
            (err, instance, isNew) => {
              log('is new user instance: ', isNew);
              if (err) {
                return reject(err);
              }
              return resolve(instance);
            }
          )
        );

    let donatingUser = {};
    let donation = {
      email,
      amount,
      duration,
      provider: 'stripe',
      startDate: new Date(Date.now()).toISOString()
    };

    const createCustomer = user => {
      donatingUser = user;
      return stripe.customers.create({
        email,
        card: id
      });
    };

    const createOneTimeCharge = customer => {
      donation.customerId = customer.id;
      return stripe.charges.create({
        amount: amount,
        currency: 'usd',
        customer: customer.id
      });
    };

    const createAsyncUserDonation = () => {
      donatingUser
        .createDonation(donation)
        .toPromise()
        .catch(err => {
          throw new Error(err);
        });
    };

    return Promise.resolve(fccUser)
      .then(createCustomer)
      .then(customer => {
        return createOneTimeCharge(customer).then(charge => {
          donation.subscriptionId = 'one-time-charge-prefix-' + charge.id;
          return res.send(charge);
        });
      })
      .then(createAsyncUserDonation)
      .catch(err => {
        if (err.type === 'StripeCardError') {
          return res.status(402).send({ error: err.message });
        }
        return res
          .status(500)
          .send({ error: 'Donation failed due to a server error.' });
      });
  }

  function createHmacHash(req, res) {
    const { user, body } = req;

    if (!user || !body) {
      return res
        .status(500)
        .send({ error: 'User must be signed in for this request.' });
    }

    const { email } = body;

    if (!isEmail('' + email)) {
      return res
        .status(500)
        .send({ error: 'The email is invalid for this request.' });
    }

    if (!user.donationEmails.includes(email)) {
      return res.status(500).send({
        error: `User does not have the email: ${email} associated with their donations.`
      });
    }

    log(`creating HMAC hash for ${email}`);
    return Promise.resolve(email)
      .then(email =>
        crypto
          .createHmac('sha256', keys.servicebot.hmacKey)
          .update(email)
          .digest('hex')
      )
      .then(hash => res.status(200).json({ hash }))
      .catch(() =>
        res
          .status(500)
          .send({ error: 'Donation failed due to a server error.' })
      );
  }

  const pubKey = keys.stripe.public;
  const secKey = keys.stripe.secret;
  const hmacKey = keys.servicebot.hmacKey;
  const secretInvalid = !secKey || secKey === 'sk_from_stripe_dashboard';
  const publicInvalid = !pubKey || pubKey === 'pk_from_stripe_dashboard';
  const hmacKeyInvalid =
    !hmacKey || hmacKey === 'secret_key_from_servicebot_dashboard';

  if (secretInvalid || publicInvalid || hmacKeyInvalid) {
    if (process.env.FREECODECAMP_NODE_ENV === 'production') {
      throw new Error('Stripe API keys are required to boot the server!');
    }
    console.info('No Stripe API keys were found, moving on...');
    done();
  } else {
    api.post('/charge-stripe', createStripeDonation);
    api.post('/charge-stripe-year-end', createStripeDonationYearEnd);
    api.post('/create-hmac-hash', createHmacHash);
    donateRouter.use('/donate', api);
    app.use(donateRouter);
    app.use('/internal', donateRouter);
    app.use('/unauthenticated', donateRouter);
    connectToStripe().then(done);
  }
}
