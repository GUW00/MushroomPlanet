// config.js
// Centralized configuration for the Sporebot landing page and integrations

const config = {
  site: {
    title: "Welcome to Mushroom Planet",
    headerTitle: "Mushroom Planet",
    description: "The Official Home of the SHROOM & SPORE Token, Mooshie NFTs & Sporebot Farming! ",
    url: "https://mushroomplanet.earth/" // Update this to your actual domain
  },

  discord: {
    inviteCode: "RgUh9kHx86",
    inviteURL: "https://discord.com/invite/RgUh9kHx86",
    guildID: "1190059108368400535"
  },

  theme: {
    colors: {
      primary: "#ffffe1",       // Cream text or background
      secondary: "#fece00",     // Yellow highlights
      accent: "#fd464f",        // Red accent
      dark: "#1a1a1a",          // Dark section background
      light: "#e8e8d0",         // Light section background (cream-like)

      sections: {
        altLightBg: "#ffffe1",   // Alt section: cream background
        altLightText: "#1a1a1a", // ...with dark text
        altDarkBg: "#1a1a1a",    // Alt section: dark background
        altDarkText: "#ffffe1"  // ...with light text
      },

      embed: {
        background: "#fd464f",
        border: "#fee599",
        text: "#ffffe1",
        link: "#ffffe1"
      }
    },
    fonts: {
      heading: "'Inter', sans-serif",
      body: "'Inter', sans-serif"
    }
  },

  metadata: {
    googleFonts: ["Inter:wght@400;600;800"],
    socialCard: {
      title: "Sporebot | Mushroom Farming Bot",
      description: "Join our Discord to start your mushroom farm journey with Sporebot!",
      image: "/images/social-card.png"  // Update if you change the OG image
    }
  },

  analytics: {
    googleAnalyticsID: "UA-XXXXXXXXX-X" // Replace with your real GA ID
  },

  menu: {
    html: `
      <div class="main-menu desktop-only">
        <a href="index.html">Home</a>
        <a href="nft.html">NFT</a>
        <a href="sporebot.html">Sporebot</a>
        <a href="token/">Token</a>
        <a href="rewards.html">Rewards</a>
        <a href="guides.html">Guides</a>
      </div>

      <div class="mobile-menu mobile-only">
        <a href="index.html">Home</a>
        <a href="nft.html">NFT</a>
        <a href="sporebot.html">Sporebot</a>
        <a href="token.html">Token</a>
        <a href="rewards.html">Rewards</a>
        <a href="guides.html">Guides</a>
        </a>
      </div>
    `
  }

};

export default config;
