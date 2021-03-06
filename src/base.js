import { getDocs, query, onSnapshot, doc, setDoc, getFirestore, Timestamp, updateDoc, collection} from "firebase/firestore"; 
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut} from "firebase/auth";
import axios from "axios";
import  UserData from "./baseUtils.js";

// Make a new user with provided username and password 
export async function createUser(username, password) {
  const db = getFirestore();
  const auth = getAuth();
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, username, password);
    const user = userCredential.user;
    await setDoc(doc(db, "Users", user.uid), {
      name: username,
      accountValue: [100000],
      stocks: "{}",
      cash: 100000,
      usersTimestamp: Timestamp.now()
    });
    return true;
  } catch(error) {
    return error.message;
  }
}

/* Return true if the user successfully signed in, 
 * return false otherwise
 */
export async function signIn(username, password) {
  const auth = getAuth();
  try {
    await signInWithEmailAndPassword(auth, username, password);
    return true;
  } catch(error) {
    return error.message;
  }
}

export function logOut() {
  const auth = getAuth();
  return new Promise((resolve, reject) => {
    signOut(auth).then(() => {
      resolve(true);
    }).catch((err) => {
      resolve(false);
    });
  });
}

/*
 * Check if the user is signed in
 * Return null if user is not signed and the uid if the user is signed in.
 */
export function checkLoginStatus() {
  const auth = getAuth();
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, function(user) {
      if (user) {
        resolve(user.uid);
      } else {
        resolve(null);
      }
    })
  });
}

/* You should still ask for the uid by running checkLoginStatus 
 * before to make sure they're logged in before showing the stock data
 * for the getUserStockData and getLeaderboardData
 */
export async function setUserStockData(uid, userData) {
  const db = getFirestore();
  if (!uid) {
    return false;
  }
  try {
    // Sync user's data on the database with updated version
    await updateDoc(doc(db, "Users", uid ), {
      cash: userData.cash,
      stocks: JSON.stringify(userData.stocks),
    });
    return true;
  } catch (e) {
    console.log(e);
    return false;
  }
}

export async function getUserStockData(uid) {
  const db = getFirestore();
  if (!(await checkLoginStatus())) {
    return null;
  }
  return new Promise((resolve, reject) => {
      onSnapshot(doc(db, "Users", uid), (doc) => {
          const userData = new UserData(doc.data().name, doc.data().accountValue, 
                                  JSON.parse(doc.data().stocks), doc.data().cash, 
                                  doc.data().usersTimestamp);
          resolve(userData);
      });
  });
}

export async function getLeaderboardData() {
  const db = getFirestore();
  var data = [];
  let userData = null;
  if (await checkLoginStatus()) {
    const leaderboardData = query(collection(db, "Users"));
    const querySnapshot = await getDocs(leaderboardData);
    querySnapshot.forEach((doc) => {
      userData = new UserData(doc.data().name, doc.data().accountValue, 
       JSON.parse(doc.data().stocks), doc.data().cash, doc.data().usersTimestamp);
      data.push(userData);
    });
  } else {
    return null;
  }
  return data;
}

export async function updateAllUsers() {
  const db = getFirestore();
  
  const leaderboardData = query(collection(db, "Users"));
  const querySnapshot = await getDocs(leaderboardData);
  await querySnapshot.forEach(async (document) => {
    const userData = new UserData(document.data().name, document.data().accountValue, 
      JSON.parse(document.data().stocks), document.data().cash, document.data().usersTimestamp);

    // Convert to EDT first to avoid having to deal with Daylight Savings :(
    const lastRecordedDay = userData.usersTimestamp.toDate()
      .toLocaleString("en-US", {timeZone: "America/New_York"}).split(" ");
    const currentDate = new Date().toLocaleString("en-US", {timeZone: "America/New_York"}).split(" ");
    const currentEdtHour = parseInt(currentDate[1].split(":")[0]) + (currentDate[2] === "PM" ? 12 : 0);
    const currentEdtDay = parseInt(currentDate[0].split("/")[1]);

    /* Update the stocks if it has not been updated that day,
     * while making sure to do it only when the NYSE is not open 
     * In EDT, the NYSE is open from 9:30am - 4:00pm during weekdays
     */ 
    if ((!(currentEdtHour >= 9 && currentEdtHour < 16) || (currentEdtDay === 7 || currentEdtDay === 6))
       && (currentDate[0] !== lastRecordedDay[0])) {

      let updatedTotal = userData.cash;

      for (const stock in userData.stocks) {
        const updatedPrice = (await axios.get("/stock", {params: {symbol: stock}})).data.price.regularMarketPrice;
        updatedTotal += updatedPrice * userData.stocks[stock].amount;
      }
      
      userData.accountValue.push(updatedTotal);
      userData.usersTimestamp = Timestamp.now();
      
      updateDoc(doc(db, "Users", document.id), {accountValue: userData.accountValue, usersTimestamp: userData.usersTimestamp});
    }
  });
}


/* Trade stock attemps to sell/buy a certain amount
 * of a stock specified by the ticker. If the user is 
 * not able to buy/sell the specified amount, then return 
 * false. Only valid tickers can reach the sell/buy menu
*/
export async function tradeStock(ticker, amount) {

  const uid = checkLoginStatus();
  const userData = await getUserStockData(await uid);

  if (!(userData) || amount === 0) {
    return false;
  }

  const stockData = (await axios.get("/stock", {params: {symbol: ticker}})).data;
  const currentValue = amount * stockData.price.regularMarketPrice;
  /* Check that the user is logged in 
   * Also verify that the amount is a non-zero amount
   * (this should never happen)
   */

  if (amount < 0) {
    // Handle stock selling
    if (userData.stocks.hasOwnProperty(ticker) && userData.stocks[ticker].amount >= (-1 * amount)) {
      userData.cash -= currentValue;
      userData.stocks[ticker].amount += amount;
      userData.stocks[ticker].currentValue += currentValue;

      // Round stock value to the nearest penny
      userData.stocks[ticker].currentValue = parseFloat(userData.stocks[ticker].currentValue.toFixed(2));

      // Remove stock if all shares are sold
      if (userData.stocks[ticker].amount === 0) {
        delete userData.stocks[ticker];
      }
    } else {
      console.log("Not enough stocks");
      // Not enough stocks
      return false;
    }
  } else  {
    // Handle stock purchasing
    if (userData.cash >= currentValue) {
      if (userData.stocks.hasOwnProperty(ticker)) {
        userData.stocks[ticker].amount += amount;
        userData.stocks[ticker].currentValue += currentValue;
      } else {
        userData.stocks[ticker] = {
          amount: amount,
          currentValue: currentValue,
          longName: stockData.price.longName
        }
      }
      userData.cash -= currentValue;
    } else {
      // Not enough cash
      return false;
    }
    // Round stock value to the nearest penny
    userData.stocks[ticker].currentValue = parseFloat(userData.stocks[ticker].currentValue.toFixed(2));
  }

  // Round cash to the nearest penny
  userData.cash = parseFloat(userData.cash.toFixed(2));
  return await setUserStockData(await uid, userData);
}