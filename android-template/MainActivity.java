package __APP_ID__;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // ACCESS_MEDIA_LOCATION é permissão de execução: sem ela o Android apaga o GPS das fotos escolhidas.
        // Vem junto com a leitura de imagens (mesmo grupo), então pedimos as duas de uma vez.
        if (Build.VERSION.SDK_INT >= 29) {
            List<String> need = new ArrayList<>();
            String read = Build.VERSION.SDK_INT >= 33
                ? Manifest.permission.READ_MEDIA_IMAGES
                : Manifest.permission.READ_EXTERNAL_STORAGE;
            if (ContextCompat.checkSelfPermission(this, read) != PackageManager.PERMISSION_GRANTED) need.add(read);
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_MEDIA_LOCATION) != PackageManager.PERMISSION_GRANTED)
                need.add(Manifest.permission.ACCESS_MEDIA_LOCATION);
            if (!need.isEmpty()) ActivityCompat.requestPermissions(this, need.toArray(new String[0]), 9001);
        }
    }
}
