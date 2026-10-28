# Stage 1: build
FROM maven:3.9.6-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn -q dependency:go-offline
COPY src ./src
RUN mvn -q package -DskipTests

# Stage 2: run (sized for a 512 MB container such as Render Free)
FROM eclipse-temurin:17-jre-jammy
WORKDIR /app
COPY --from=build /app/target/backend-0.0.1-SNAPSHOT.jar app.jar
RUN useradd -m appuser
USER appuser

# Production profile reads DATABASE_URL, DATABASE_USERNAME, DATABASE_PASSWORD,
# ALLOWED_ORIGINS and JWT_SECRET from the environment. PORT is honored by the app.
ENV SPRING_PROFILES_ACTIVE=prod
EXPOSE 8080
ENTRYPOINT ["java", "-Xmx300m", "-XX:MaxMetaspaceSize=128m", "-XX:+UseSerialGC", "-Xss512k", "-jar", "app.jar"]
