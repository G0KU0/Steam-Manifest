require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const axios = require('axios');
const express = require('express');

// --- RENDER.COM ÉLETBEN TARTÁS ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

// --- DISCORD BOT LOGIKA ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
    console.log(`Bejelentkezve mint: ${client.user.tag}`);
    
    const command = new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('Steam manifest letöltése AppID alapján')
        .addStringOption(option => 
            option.setName('appid')
                .setDescription('A játék Steam AppID-ja')
                .setRequired(true));

    client.application.commands.create(command);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'manifest') {
        const appId = interaction.options.getString('appid').trim();

        if (!/^\d+$/.test(appId)) {
            return interaction.reply({ content: '❌ Hiba: Csak számokat adj meg!', ephemeral: true });
        }

        await interaction.deferReply();

        try {
            // Ellenőrzés és letöltés a forrásfájlok alapján
            const checkUrl = `https://api.github.com/repos/SteamAutoCracks/ManifestHub/branches/${appId}`;
            const downloadUrl = `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${appId}`;

            await axios.get(checkUrl);

            const response = await axios({
                method: 'get',
                url: downloadUrl,
                responseType: 'arraybuffer'
            });

            const attachment = new AttachmentBuilder(Buffer.from(response.data), { name: `manifest_${appId}.zip` });

            const embed = new EmbedBuilder()
                .setColor(0x00A000)
                .setTitle('Steam Manifest Hub - CLI Edition') //
                .setDescription(`A(z) **${appId}** manifestje sikeresen letöltve.`)
                .addFields(
                    { name: 'Fontos [DISCLAIMER]', value: 'Ez a szkript csak tájékoztató jellegű. Nem vállalunk felelősséget az adatok használatából eredő következményekért.' } //
                )
                .setFooter({ text: '© 2026 SSMG4 | ManifestHub Database' }); //

            await interaction.editReply({ embeds: [embed], files: [attachment] });

        } catch (error) {
            await interaction.editReply({ content: `> Manifest nem található a(z) **${appId}** AppID-hoz.` }); //
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
