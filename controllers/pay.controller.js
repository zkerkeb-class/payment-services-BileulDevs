const logger = require("../config/logger");
const stripe = require("../config/stripe");
const axios = require('axios');
require("dotenv").config();

// Créer une session de paiement
exports.createCheckoutSession = async (req, res) => {
  const { amount, currency, productName, userId, premiumId, duration } = req.body;

  logger.info(`💰 Demande de création de session : ${productName}, ${amount} ${currency}`);

  // Validation des paramètres requis
  if (!userId || !premiumId) {
    return res.status(400).json({
      success: false,
      error: 'userId et premiumId sont requis pour créer une session de paiement'
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'paypal'],
      line_items: [{
        price_data: {
          currency: currency || 'eur',
          product_data: {
            name: productName || 'Abonnement Premium',
          },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: 'http://localhost:3009/payement/success',
      cancel_url: 'http://localhost:3009/payement/error',
      metadata: {
        userId: userId,
        premiumId: premiumId,
        duration: duration || '30' // Durée par défaut de 30 jours
      }
    });

    logger.info(`✅ Session Stripe créée : ${session.id} pour utilisateur ${userId}`);
    res.json({ 
      success: true,
      url: session.url,
      sessionId: session.id
    });
  } catch (error) {
    logger.error(`❌ Erreur création session Stripe : ${error.message}`);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};


// Gérer les webhooks Stripe
exports.handleWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    logger.info(`📩 Webhook Stripe reçu : ${event.type}`);
  } catch (err) {
    logger.error(`❌ Webhook invalide : ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Gestion des événements
  console.log(event);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        logger.info(`✅ Paiement complété. Session ID : ${session.id}`);
        
        // Récupérer les métadonnées de la session
        const { userId, premiumId, duration } = session.metadata;
        
        if (!userId || !premiumId) {
          logger.error('❌ Métadonnées manquantes dans la session Stripe');
          break;
        }

        // Vérifier si le premium existe via le service BDD
        const premiumResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/premium/${premiumId}`);
        if (!premiumResponse.data) {
          logger.error(`❌ Premium non trouvé : ${premiumId}`);
          break;
        }

        const premium = premiumResponse.data;

        // Calculer les dates de subscription
        const startDate = new Date();
        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + parseInt(duration || 30));

        // Créer la subscription via le service BDD
        const subscriptionData = {
          userId,
          premiumId,
          status: 'active',
          startDate,
          endDate,
          autoRenew: true,
          paymentMethod: 'credit_card',
          transactionId: session.payment_intent || session.id,
          amount: session.amount_total / 100, // Convertir de centimes en euros
          duration: parseInt(duration || 30)
        };

        const subscriptionResponse = await axios.post(`${process.env.SERVICE_BDD_URL}/api/subscription`, subscriptionData);
        
        logger.info(`✅ Subscription créée avec succès pour l'utilisateur ${userId}`);
        
        // TODO: Envoyer un email de confirmation à l'utilisateur
        // TODO: Mettre à jour le statut premium de l'utilisateur
        
        break;

      case 'invoice.payment_succeeded':
        const invoice = event.data.object;
        logger.info(`✅ Paiement de facture réussi. Invoice ID : ${invoice.id}`);
        
        // Traiter le renouvellement automatique
        if (invoice.subscription) {
          await handleSubscriptionRenewal(invoice);
        }
        
        break;

      case 'invoice.payment_failed':
        const failedInvoice = event.data.object;
        logger.warn(`⚠️ Échec du paiement de facture. Invoice ID : ${failedInvoice.id}`);
        
        // Traiter l'échec de paiement
        await handlePaymentFailure(failedInvoice);
        
        break;

      case 'customer.subscription.deleted':
        const deletedSubscription = event.data.object;
        logger.info(`🗑️ Subscription Stripe supprimée : ${deletedSubscription.id}`);
        
        // Marquer la subscription comme annulée
        await handleSubscriptionCancellation(deletedSubscription);
        
        break;

      case 'customer.subscription.updated':
        const updatedSubscription = event.data.object;
        logger.info(`🔄 Subscription Stripe mise à jour : ${updatedSubscription.id}`);
        
        // Mettre à jour le statut de la subscription
        await handleSubscriptionUpdate(updatedSubscription);
        
        break;

      default:
        logger.info(`🔍 Événement non traité : ${event.type}`);
    }
  } catch (error) {
    logger.error(`❌ Erreur lors du traitement du webhook : ${error.message}`);
    return res.status(500).json({ error: 'Erreur interne du serveur' });
  }

  res.json({ received: true });
};

// Fonction pour gérer le renouvellement automatique
async function handleSubscriptionRenewal(invoice) {
  try {
    // Rechercher la subscription par transaction ID via le service BDD
    const searchResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/subscription/search`, {
      params: { transactionId: invoice.subscription }
    });

    if (searchResponse.data.success && searchResponse.data.data.subscriptions.length > 0) {
      const subscription = searchResponse.data.data.subscriptions[0];
      
      // Renouveler la subscription via le service BDD
      await axios.patch(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}/renew`, {
        duration: 30
      });

      logger.info(`✅ Subscription renouvelée pour l'utilisateur ${subscription.userId}`);
    }
  } catch (error) {
    logger.error(`❌ Erreur lors du renouvellement : ${error.message}`);
  }
}

// Fonction pour gérer l'échec de paiement
async function handlePaymentFailure(invoice) {
  try {
    const searchResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/subscription/search`, {
      params: { transactionId: invoice.subscription }
    });

    if (searchResponse.data.success && searchResponse.data.data.subscriptions.length > 0) {
      const subscription = searchResponse.data.data.subscriptions[0];
      
      // Marquer comme inactive via le service BDD
      await axios.patch(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}`, {
        status: 'inactive',
        autoRenew: false
      });

      logger.warn(`⚠️ Subscription désactivée pour échec de paiement : ${subscription.userId}`);
      
      // TODO: Envoyer un email d'alerte à l'utilisateur
    }
  } catch (error) {
    logger.error(`❌ Erreur lors du traitement de l'échec : ${error.message}`);
  }
}

// Fonction pour gérer l'annulation de subscription
async function handleSubscriptionCancellation(stripeSubscription) {
  try {
    const searchResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/subscription/search`, {
      params: { transactionId: stripeSubscription.id }
    });

    if (searchResponse.data.success && searchResponse.data.data.subscriptions.length > 0) {
      const subscription = searchResponse.data.data.subscriptions[0];
      
      // Annuler la subscription via le service BDD
      await axios.patch(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}/cancel`);

      logger.info(`✅ Subscription annulée pour l'utilisateur ${subscription.userId}`);
    }
  } catch (error) {
    logger.error(`❌ Erreur lors de l'annulation : ${error.message}`);
  }
}

// Fonction pour gérer la mise à jour de subscription
async function handleSubscriptionUpdate(stripeSubscription) {
  try {
    const searchResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/subscription/search`, {
      params: { transactionId: stripeSubscription.id }
    });

    if (searchResponse.data.success && searchResponse.data.data.subscriptions.length > 0) {
      const subscription = searchResponse.data.data.subscriptions[0];
      
      // Déterminer le nouveau statut basé sur le statut Stripe
      let newStatus = 'active';
      if (stripeSubscription.status === 'canceled') {
        newStatus = 'cancelled';
      } else if (stripeSubscription.status === 'past_due') {
        newStatus = 'inactive';
      }
      
      // Mettre à jour via le service BDD
      await axios.patch(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}`, {
        status: newStatus
      });

      logger.info(`✅ Subscription mise à jour pour l'utilisateur ${subscription.userId} - Statut: ${newStatus}`);
    }
  } catch (error) {
    logger.error(`❌ Erreur lors de la mise à jour : ${error.message}`);
  }
}

// Fonction utilitaire pour gérer les erreurs d'API
function handleApiError(error, operation) {
  if (error.response) {
    logger.error(`❌ Erreur API ${operation}: ${error.response.status} - ${error.response.data.message || error.response.data}`);
  } else if (error.request) {
    logger.error(`❌ Erreur réseau ${operation}: Service BDD non disponible`);
  } else {
    logger.error(`❌ Erreur ${operation}: ${error.message}`);
  }
}